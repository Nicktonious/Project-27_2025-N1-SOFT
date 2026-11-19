import { EventEmitter2 } from 'eventemitter2';
import type ClassVendingSectionFacadeType from '#js/srvSpiralSection/js/srvVendingSectionFacade.js';
import { FaultDispatcher } from './FaultDispatcher.js';
import { ScenarioReportBuilder, type PushTimelineEvent } from './ReportBuilder.js';
import {
    createEmulatorEnv,
    createFacadeEnv,
    createStatesController,
    resolveMachineAndSectionConfig,
    type ScenarioRunOptions,
} from './runContext.js';
import {
    parseScenario,
    type FacadeResponseItem,
    type NormalizedScenario,
    type ScenarioReport,
    type TestScenarioInput,
} from '../../shared/scenario.schema.js';

export type { ScenarioRunOptions };

const INIT_SETTLE_MS = 80;

function buildTransactionPayload(order: NormalizedScenario['order'], fallbackId: string): Record<string, unknown> {
    const base = { Command: order.command, ID: order.id ?? fallbackId };
    if (order.command === 'GetItem' || order.command === 'RotateSpiral') {
        return { ...base, Cells: order.cells };
    }
    if (order.command === 'SetLiftLevel') {
        return { ...base, Level: order.level };
    }
    return base;
}

/**
 * Оркестратор прогона JSON-сценариев поверх реального StatesController, DeviceEmulator и Facade.
 */
export class ScenarioRunner extends EventEmitter2 {
    private abortFn: (() => void) | null = null;
    private abortRequested = false;

    abort(): boolean {
        if (this.abortFn) {
            this.abortFn();
            return true;
        }
        this.abortRequested = true;
        return true;
    }

    async run(rawScenario: TestScenarioInput, opts: ScenarioRunOptions = {}): Promise<ScenarioReport> {
        this.abortRequested = false;
        const scenario = parseScenario(rawScenario);
        const report = new ScenarioReportBuilder(scenario.name, (ev) => this.emit('timeline', ev));

        const { config, secConf } = resolveMachineAndSectionConfig(scenario, opts);
        const statesController = createStatesController(config, scenario.statesOverride, opts.statesController);
        const { stub, emu } = createEmulatorEnv(config, secConf, scenario.channelsPatch);
        const facade = createFacadeEnv(secConf, stub, statesController, report.addEvent);
        let dispatcher: FaultDispatcher | null = null;

        try {
            await new Promise((r) => setTimeout(r, INIT_SETTLE_MS));
            stub.clearHistory();
            report.clearTimeline();

            facade.Section.Box.unlockTimeout = scenario.emulator.boxUnlockTimeoutSec;
            const sim = emu.attachSectionSimulation(scenario.emulator);

            dispatcher = new FaultDispatcher({
                stub,
                statesController,
                sim,
                onFaultTriggered: (info) => report.addFault(info),
            });

            facade.Events.on('response', (msg: FacadeResponseItem) => report.addResponse(msg));
            facade.Section.on('result', (res: { ok: boolean; cell: { row: number; column: number } | null }) =>
                report.addResult(res)
            );

            dispatcher.applyStartFaults(scenario.faults);
            dispatcher.armRuntimeFaults(scenario.faults);
            report.addEvent('lifecycle', `Старт сценария "${scenario.name}" (${scenario.order.command})`);

            if (this.abortRequested) {
                report.addEvent('lifecycle', 'Сценарий прерван пользователем', { level: 'W' });
                return report.build({ aborted: true, timedOut: false, statesController, stub });
            }

            const txPromise = facade.PerformTransaction(
                buildTransactionPayload(scenario.order, `tx-hmi-${report.startedAtMs}`)
            );
            const { aborted, timedOut } = await this.awaitTransaction(
                txPromise,
                facade,
                scenario.timeoutMs,
                report.addEvent
            );

            return report.build({ aborted, timedOut, statesController, stub });
        } finally {
            this.abortFn = null;
            dispatcher?.cleanup();
            emu.cleanup();
            facade.Reset();
            stub.reset({ removeListeners: true });
        }
    }

    private awaitTransaction(
        txPromise: Promise<unknown>,
        facade: ClassVendingSectionFacadeType,
        timeoutMs: number,
        pushEvent: PushTimelineEvent
    ): Promise<{ aborted: boolean; timedOut: boolean }> {
        return new Promise((resolve) => {
            let settled = false;
            let aborted = false;
            let timedOut = false;

            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);
                resolve({ aborted, timedOut });
            };

            this.abortFn = () => {
                aborted = true;
                pushEvent('lifecycle', 'Сценарий прерван пользователем', { level: 'W' });
                facade.Section.Abort();
                finish();
            };

            const watchdog = setTimeout(() => {
                timedOut = true;
                pushEvent('lifecycle', `Превышен watchdog-таймаут ${timeoutMs} мс`, { level: 'E' });
                facade.Section.Abort();
                finish();
            }, timeoutMs);

            txPromise.then(finish, (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                pushEvent('log', `Исключение транзакции: ${msg}`, { level: 'E' });
                finish();
            });
        });
    }
}
