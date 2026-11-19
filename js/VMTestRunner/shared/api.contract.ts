import type { ScenarioReport, TestScenarioInput } from './scenario.schema.js';

export type SectionType = 'SPIRAL' | 'CELL';

export type RunStatus = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'ABORTED' | 'TIMED_OUT' | 'ERROR';

export interface SectionMeta {
    type: SectionType;
    label: string;
    supported: boolean;
    commands: string[];
    availableChannels: string[];
}

export interface StartRunRequest {
    sectionType: SectionType;
    scenario: TestScenarioInput;
}

export interface StartRunResponse {
    runId: string;
    status: RunStatus;
}

export interface RunStatusResponse {
    runId: string;
    sectionType: SectionType;
    status: RunStatus;
    report: ScenarioReport | null;
    error?: string;
}

export interface ApiError {
    error: string;
    details?: unknown;
}
