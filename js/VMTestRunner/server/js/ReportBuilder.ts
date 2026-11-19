import type StatesControllerType from '#js/srvStatesController/js/srvSectionStateController.ts';
import type { ProxyChannelStub as ProxyChannelStubType } from '#root/tests/helpers/ProxyChannelStub.js';
import type { FacadeResponseItem, ScenarioReport, TimelineEvent } from '../../shared/scenario.schema.js';

export type PushTimelineEvent = (
    kind: TimelineEvent['kind'],
    message: string,
    extra?: { level?: string; data?: unknown }
) => void;

/**
 * Builder итогового отчёта прогона сценария.
 * Инкапсулирует накопление событий, ответов, результатов секции и сработавших аварий.
 */
export class ScenarioReportBuilder {
    readonly startedAtMs = Date.now();
    private readonly startedAt = new Date(this.startedAtMs).toISOString();
    private readonly scenarioName: string;
    private readonly onEvent: (ev: TimelineEvent) => void;

    private readonly timeline: TimelineEvent[] = [];
    private readonly responses: FacadeResponseItem[] = [];
    private readonly sectionResults: Array<{ ok: boolean; cell: { row: number; column: number } | null }> = [];
    private readonly triggeredFaults: Array<{ id: string; triggeredAtMs: number; actionType: string }> = [];

    constructor(scenarioName: string, onEvent: (ev: TimelineEvent) => void) {
        this.scenarioName = scenarioName;
        this.onEvent = onEvent;
    }

    readonly addEvent: PushTimelineEvent = (kind, message, extra = {}) => {
        const now = Date.now();
        const ev: TimelineEvent = {
            timestamp: now,
            elapsedMs: now - this.startedAtMs,
            kind,
            message,
            ...extra,
        };
        this.timeline.push(ev);
        this.onEvent(ev);
    };

    clearTimeline(): void {
        this.timeline.length = 0;
    }

    addFault(info: { id: string; actionType: string }): void {
        this.triggeredFaults.push({ ...info, triggeredAtMs: Date.now() - this.startedAtMs });
        this.addEvent('fault', `Сработала авария [${info.id}]: ${info.actionType}`, {
            level: 'W',
            data: info,
        });
    }

    addResponse(msg: FacadeResponseItem): void {
        this.responses.push(msg);
        this.addEvent('response', `Ответ фасада: ${msg.Response.Result}`, {
            level: msg.Response.Result === 'OK' ? 'I' : 'E',
            data: msg,
        });
    }

    addResult(res: { ok: boolean; cell: { row: number; column: number } | null }): void {
        this.sectionResults.push(res);
        this.addEvent('result', `Результат секции: ok=${res.ok}`, { data: res });
    }

    build(params: {
        aborted: boolean;
        timedOut: boolean;
        statesController: StatesControllerType;
        stub: ProxyChannelStubType;
    }): ScenarioReport {
        return {
            scenarioName: this.scenarioName,
            startedAt: this.startedAt,
            durationMs: Date.now() - this.startedAtMs,
            aborted: params.aborted,
            timedOut: params.timedOut,
            responses: this.responses,
            sectionResults: this.sectionResults,
            triggeredFaults: this.triggeredFaults,
            timeline: this.timeline,
            states: JSON.parse(JSON.stringify(params.statesController.Machine.States)),
            channelHistoryCount: {
                set: params.stub.getSetHistory().length,
                get: params.stub.getGetHistory().length,
            },
        };
    }
}
