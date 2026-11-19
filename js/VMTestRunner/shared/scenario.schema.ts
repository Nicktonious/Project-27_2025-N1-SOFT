import { z } from 'zod';

const OrderCellSchema = z.object({
    row: z.number().int().min(0),
    column: z.number().int().min(0),
    quantity: z.number().int().min(1).default(1),
});

const OrderSchema = z.discriminatedUnion('command', [
    z.object({
        id: z.string().optional(),
        command: z.literal('GetItem'),
        cells: z.array(OrderCellSchema).min(1, 'order.cells должен содержать хотя бы одну ячейку'),
    }),
    z.object({
        id: z.string().optional(),
        command: z.literal('RotateSpiral'),
        cells: z.array(OrderCellSchema).min(1, 'order.cells должен содержать 1 ячейку'),
    }),
    z.object({
        id: z.string().optional(),
        command: z.literal('SetLiftLevel'),
        level: z.number().int().min(0),
    }),
    z.object({
        id: z.string().optional(),
        command: z.literal('OpenDeliveryBox'),
    }),
]);

const EmulatorConfigSchema = z
    .object({
        liftStartDelayMs: z.number().min(0).default(40),
        liftStepIntervalMs: z.number().min(1).default(30),
        spiralFirstPulseDelayMs: z.number().min(0).default(880),
        boxOpenDelayMs: z.number().min(0).default(60),
        boxHoldOpenMs: z.number().min(0).default(360),
        boxUnlockTimeoutSec: z.number().min(0.1).default(2),
        silentAck: z.boolean().default(false),
        driverError: z.string().nullable().default(null),
        liftNoPower: z.boolean().default(false),
        liftShortOnStart: z.boolean().default(false),
        spiralNoPower: z.boolean().default(false),
        spiralNoPowerTargets: z.array(z.number().int().min(0)).default([]),
        spiralShortOnStep1: z.boolean().default(false),
        spiralShortTargets: z.array(z.number().int().min(0)).default([]),
        suppressLevelSensor: z.boolean().default(false),
        suppressTamperPulse: z.boolean().default(false),
        suppressBoxOpen: z.boolean().default(false),
        initialLiftLevel: z.number().int().min(0).default(0),
    })
    .prefault({});

const FaultTriggerSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('afterMs'), ms: z.number().min(0) }),
    z.object({
        type: z.literal('onChannelSet'),
        channel: z.string().min(1),
        match: z.unknown().optional(),
        occurrence: z.number().int().min(1).default(1),
    }),
]);

const FaultActionSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('injectChannel'),
        channel: z.string().min(1),
        value: z.unknown(),
        samples: z.number().int().min(1).default(1),
    }),
    z.object({
        type: z.literal('patchStates'),
        patch: z.record(z.string(), z.unknown()),
    }),
    z.object({
        type: z.literal('patchEmulator'),
        patch: z.record(z.string(), z.unknown()),
    }),
]);

const FaultRuleSchema = z
    .object({
        id: z.string().min(1),
        enabled: z.boolean().default(true),
        mode: z.enum(['atStart', 'runtime']).default('runtime'),
        when: FaultTriggerSchema.optional(),
        delayMs: z.number().min(0).default(0),
        action: FaultActionSchema,
    })
    .superRefine((rule, ctx) => {
        if (rule.mode === 'runtime' && !rule.when) {
            ctx.addIssue({
                code: 'custom',
                path: ['when'],
                message: 'Для рантайм-аварии необходимо указать триггер (when)',
            });
        }
    });

export const TestScenarioSchema = z
    .object({
        name: z.string().trim().min(1).default('Безымянный сценарий'),
        description: z.string().default(''),
        machineConfig: z.record(z.string(), z.unknown()).optional(),
        statesOverride: z.record(z.string(), z.unknown()).optional(),
        section: z
            .object({
                id: z.string().default('1'),
                rows: z.number().int().min(1).max(20).default(4),
                cols: z.number().int().min(1).max(20).default(4),
                powerBus: z.string().default('BUS-1'),
            })
            .prefault({}),
        channelsPatch: z.record(z.string(), z.unknown()).default({}),
        emulator: EmulatorConfigSchema,
        order: OrderSchema,
        faults: z.array(FaultRuleSchema).default([]),
        timeoutMs: z.number().min(100).default(15000),
    })
    .superRefine((val, ctx) => {
        if (val.order.command === 'GetItem' || val.order.command === 'RotateSpiral') {
            val.order.cells.forEach((cell, idx) => {
                if (cell.row >= val.section.rows) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['order', 'cells', idx, 'row'],
                        message: `row=${cell.row} выходит за пределы section.rows=${val.section.rows}`,
                    });
                }
                if (cell.column >= val.section.cols) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['order', 'cells', idx, 'column'],
                        message: `column=${cell.column} выходит за пределы section.cols=${val.section.cols}`,
                    });
                }
            });
        }
    });

export type TestScenarioInput = z.input<typeof TestScenarioSchema>;
export type NormalizedScenario = z.output<typeof TestScenarioSchema>;
export type FaultRule = z.output<typeof FaultRuleSchema>;
export type FaultAction = z.output<typeof FaultActionSchema>;

export interface TimelineEvent {
    timestamp: number;
    elapsedMs: number;
    kind: 'log' | 'fault' | 'response' | 'result' | 'lifecycle';
    level?: string;
    message: string;
    data?: unknown;
}

export interface FacadeResponseItem {
    Response: {
        ID: string;
        ParentID: string;
        Timestamp: number;
        Target: string;
        Cell: { row: number; column: number } | null;
        Result: 'OK' | 'FAIL';
    };
}

export interface ScenarioReport {
    scenarioName: string;
    startedAt: string;
    durationMs: number;
    aborted: boolean;
    timedOut: boolean;
    responses: FacadeResponseItem[];
    sectionResults: Array<{ ok: boolean; cell: { row: number; column: number } | null }>;
    triggeredFaults: Array<{ id: string; triggeredAtMs: number; actionType: string }>;
    timeline: TimelineEvent[];
    states: unknown;
    channelHistoryCount: {
        set: number;
        get: number;
    };
}

/**
 * Парсит и валидирует JSON-сценарий через Zod, подставляя значения по умолчанию.
 */
export function parseScenario(raw: unknown): NormalizedScenario {
    return TestScenarioSchema.parse(raw);
}
