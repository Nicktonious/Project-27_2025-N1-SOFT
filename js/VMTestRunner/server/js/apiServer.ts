import Fastify, { type FastifyInstance } from 'fastify';
import type { MachineConfig } from '#js/srvStatesController/ts/IMachineConfig.ts';
import type { StartRunRequest } from '../../shared/api.contract.js';
import type { TimelineEvent } from '../../shared/scenario.schema.js';
import { HMI_PRESETS } from './presets.js';
import { createStatesController } from './runContext.js';
import { RunManager } from './RunManager.js';

const PORT = Number(process.env.PORT ?? 3001);

function writeSseEvent(stream: NodeJS.WritableStream, event: string, data: unknown): void {
    stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createApiServer(): FastifyInstance {
    const app = Fastify({ logger: false });
    const runManager = new RunManager();

    app.get('/api/presets', async () => HMI_PRESETS);

    app.post<{ Body: { machineConfig?: MachineConfig } }>('/api/states/init', async (request, reply) => {
        const machineConfig = request.body?.machineConfig;
        if (!machineConfig || typeof machineConfig !== 'object') {
            return reply.code(400).send({ error: 'Ожидается объект { machineConfig }' });
        }
        try {
            const controller = createStatesController(machineConfig);
            return { states: JSON.parse(JSON.stringify(controller.Machine.States)) };
        } catch (err) {
            return reply.code(400).send({
                error: err instanceof Error ? err.message : 'Ошибка инициализации StatesController',
            });
        }
    });

    app.post<{ Body: Partial<StartRunRequest> }>('/api/runs', async (request, reply) => {
        const { sectionType, scenario } = request.body ?? {};
        if (!sectionType || !scenario) {
            return reply.code(400).send({ error: 'Ожидается { sectionType, scenario }' });
        }
        try {
            const record = runManager.startRun(sectionType, scenario);
            return reply.code(202).send({ runId: record.runId, status: record.status });
        } catch (err) {
            return reply.code(400).send({
                error: err instanceof Error ? err.message : 'Ошибка запуска сценария',
            });
        }
    });

    app.post<{ Params: { runId: string } }>('/api/runs/:runId/abort', async (request, reply) => {
        const rec = runManager.getRecord(request.params.runId);
        if (!rec) return reply.code(404).send({ error: 'Прогон не найден' });
        const aborted = runManager.abortRun(request.params.runId);
        return { runId: rec.runId, aborted, status: rec.status };
    });

    app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (request, reply) => {
        const status = runManager.getStatus(request.params.runId);
        if (!status) return reply.code(404).send({ error: 'Прогон не найден' });
        return status;
    });

    app.get<{ Params: { runId: string } }>('/api/runs/:runId/events', (request, reply) => {
        const rec = runManager.getRecord(request.params.runId);
        if (!rec) return reply.code(404).send({ error: 'Прогон не найден' });

        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
        });

        for (const ev of rec.timeline) {
            writeSseEvent(raw, 'timeline', ev);
        }

        if (rec.status !== 'RUNNING') {
            writeSseEvent(raw, 'done', runManager.getStatus(rec.runId));
            raw.end();
            return;
        }

        const onTimeline = (ev: TimelineEvent) => writeSseEvent(raw, 'timeline', ev);
        const onDone = (status: unknown) => {
            cleanup();
            writeSseEvent(raw, 'done', status);
            raw.end();
        };
        const cleanup = () => {
            rec.emitter.off('timeline', onTimeline);
            rec.emitter.off('done', onDone);
        };

        rec.emitter.on('timeline', onTimeline);
        rec.emitter.on('done', onDone);
        request.raw.on('close', cleanup);
    });

    return app;
}

const isMain = process.argv[1]?.endsWith('apiServer.ts') || process.argv[1]?.endsWith('apiServer.js');
if (isMain) {
    createApiServer()
        .listen({ port: PORT, host: '0.0.0.0' })
        .then((address) => {
            console.log(`[VMTestRunner API] listening on ${address}`);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
