import type StatesController from '#js/srvStatesController/js/srvSectionStateController.ts';
import type { EmulatorSimulationHandle } from '#js/VMEmulator/index.js';
import type { ProxyChannelStub } from '#root/tests/helpers/ProxyChannelStub.js';
import { applyDeepPatch } from '../../shared/patch.js';
import type { FaultAction, FaultRule } from '../../shared/scenario.schema.js';

function matchesValue(actual: unknown, expected: unknown): boolean {
    if (expected === undefined) return true;
    if (expected === null || typeof expected !== 'object') return actual === expected;
    if (actual === null || typeof actual !== 'object') return false;
    const actualObj = actual as Record<string, unknown>;
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) => matchesValue(actualObj[k], v));
}

/**
 * Компактный диспетчер рантайм-аварий поверх ProxyChannelStub, StatesController и симуляции эмулятора.
 * Ожидает реальные имена каналов (резолвятся на стороне клиента из MachineConfig).
 */
export class FaultDispatcher {
    private readonly stub: ProxyChannelStub;
    private readonly statesController: StatesController;
    private readonly sim: EmulatorSimulationHandle;
    private readonly onFaultTriggered?: (info: { id: string; actionType: string }) => void;
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private readonly unsubscribers: Array<() => void> = [];

    constructor(params: {
        stub: ProxyChannelStub;
        statesController: StatesController;
        sim: EmulatorSimulationHandle;
        onFaultTriggered?: (info: { id: string; actionType: string }) => void;
    }) {
        this.stub = params.stub;
        this.statesController = params.statesController;
        this.sim = params.sim;
        this.onFaultTriggered = params.onFaultTriggered;
    }

    /**
     * Применяет аварии, помеченные mode === 'atStart', до запуска операции.
     */
    applyStartFaults(faults: FaultRule[]): void {
        for (const rule of faults) {
            if (!rule.enabled || rule.mode !== 'atStart') continue;
            this.triggerRule(rule);
        }
    }

    armRuntimeFaults(faults: FaultRule[]): void {
        for (const rule of faults) {
            if (!rule.enabled || rule.mode !== 'runtime' || !rule.when) continue;
            const when = rule.when;

            const scheduleAction = () => {
                if (rule.delayMs > 0) {
                    const t = setTimeout(() => {
                        this.timers.delete(t);
                        this.triggerRule(rule);
                    }, rule.delayMs);
                    this.timers.add(t);
                } else {
                    this.triggerRule(rule);
                }
            };

            if (when.type === 'afterMs') {
                const t = setTimeout(() => {
                    this.timers.delete(t);
                    scheduleAction();
                }, when.ms);
                this.timers.add(t);
            } else if (when.type === 'onChannelSet') {
                const { channel, match, occurrence } = when;
                let count = 0;

                const off = this.stub.onSet(channel, (val) => {
                    if (!matchesValue(val, match)) return;
                    if (++count === occurrence) {
                        off();
                        scheduleAction();
                    }
                });
                this.unsubscribers.push(off);
            }
        }
    }

    private triggerRule(rule: FaultRule): void {
        this.onFaultTriggered?.({ id: rule.id, actionType: rule.action.type });
        this.executeAction(rule.action);
    }

    executeAction(action: FaultAction): void {
        switch (action.type) {
            case 'injectChannel':
                for (let i = 0; i < action.samples; i++) {
                    this.stub.inject(action.channel, action.value, { emit: true });
                }
                break;
            case 'patchStates':
                applyDeepPatch(
                    this.statesController.Machine.States as unknown as Record<string, unknown>,
                    action.patch
                );
                break;
            case 'patchEmulator':
                Object.assign(this.sim.flags, action.patch);
                this.sim.reattach();
                break;
        }
    }

    cleanup(): void {
        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();
        for (const off of this.unsubscribers) off();
        this.unsubscribers.length = 0;
    }
}
