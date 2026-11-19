import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from 'eventemitter2';
import type { RunStatus, RunStatusResponse, SectionType } from '../../shared/api.contract.js';
import {
    parseScenario,
    type ScenarioReport,
    type TestScenarioInput,
    type TimelineEvent,
} from '../../shared/scenario.schema.js';
import { ScenarioRunner } from './ScenarioRunner.js';

export interface RunRecord {
    runId: string;
    sectionType: SectionType;
    status: RunStatus;
    runner: ScenarioRunner;
    emitter: EventEmitter2;
    timeline: TimelineEvent[];
    report: ScenarioReport | null;
    error?: string;
}

/**
 * Управляет запуском и состоянием тестовых прогонов ScenarioRunner.
 */
export class RunManager {
    private readonly runs = new Map<string, RunRecord>();

    startRun(sectionType: SectionType, scenario: TestScenarioInput): RunRecord {
        if (sectionType !== 'SPIRAL') {
            throw new Error(`Секция типа "${sectionType}" пока не поддерживается.`);
        }
        parseScenario(scenario);

        const runId = randomUUID().slice(0, 8);
        const runner = new ScenarioRunner();
        const emitter = new EventEmitter2();
        const record: RunRecord = {
            runId,
            sectionType,
            status: 'RUNNING',
            runner,
            emitter,
            timeline: [],
            report: null,
        };
        this.runs.set(runId, record);

        runner.on('timeline', (ev: TimelineEvent) => {
            record.timeline.push(ev);
            emitter.emit('timeline', ev);
        });

        runner
            .run(scenario)
            .then((report) => {
                record.report = report;
                record.status = report.aborted ? 'ABORTED' : report.timedOut ? 'TIMED_OUT' : 'COMPLETED';
                emitter.emit('done', this.toStatusResponse(record));
            })
            .catch((err: unknown) => {
                record.status = 'ERROR';
                record.error = err instanceof Error ? err.message : String(err);
                emitter.emit('done', this.toStatusResponse(record));
            });

        return record;
    }

    abortRun(runId: string): boolean {
        const rec = this.runs.get(runId);
        if (!rec || rec.status !== 'RUNNING') return false;
        return rec.runner.abort();
    }

    getRecord(runId: string): RunRecord | undefined {
        return this.runs.get(runId);
    }

    getStatus(runId: string): RunStatusResponse | undefined {
        const rec = this.runs.get(runId);
        return rec ? this.toStatusResponse(rec) : undefined;
    }

    private toStatusResponse(rec: RunRecord): RunStatusResponse {
        return {
            runId: rec.runId,
            sectionType: rec.sectionType,
            status: rec.status,
            report: rec.report,
            ...(rec.error ? { error: rec.error } : {}),
        };
    }
}
