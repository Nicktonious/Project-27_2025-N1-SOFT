import type ClassVendingSectionFacadeType from '#js/srvSpiralSection/js/srvVendingSectionFacade.js';
import type { SpiralSectionState as SpiralSectionStateType } from '#js/srvSpiralSection/js/srvSpiralSectionStates.ts';
import type * as SpiralFixtureType from '#js/srvSpiralSection/test/fixtures/spiralSection.fixture.js';
import type StatesControllerType from '#js/srvStatesController/js/srvSectionStateController.ts';
import type { MachineConfig, SectionChannelsConfig, SectionConfig } from '#js/srvStatesController/ts/IMachineConfig.ts';
import type { DeviceEmulator as DeviceEmulatorType } from '#js/VMEmulator/index.js';
import type { ProxyChannelStub as ProxyChannelStubType } from '#root/tests/helpers/ProxyChannelStub.js';
import { applyDeepPatch } from '../../shared/patch.js';
import type { NormalizedScenario } from '../../shared/scenario.schema.js';
import type { PushTimelineEvent } from './ReportBuilder.js';

const { createInitialChannelsState } = require('#js/srvSpiralSection/test/fixtures/spiralSection.fixture.js') as typeof SpiralFixtureType;
const { SpiralSectionState } = require('#js/srvSpiralSection/js/srvSpiralSectionStates.js') as {
    SpiralSectionState: typeof SpiralSectionStateType;
};
const { ProxyChannelStub } = require('#root/tests/helpers/ProxyChannelStub.js') as {
    ProxyChannelStub: typeof ProxyChannelStubType;
};
const StatesController = (
    require('#js/srvStatesController/js/srvSectionStateController.js') as { default: typeof StatesControllerType }
).default;
const ClassVendingSectionFacade = (
    require('#js/srvSpiralSection/js/srvVendingSectionFacade.js') as { default: typeof ClassVendingSectionFacadeType }
).default;
const { DeviceEmulator } = require('#js/VMEmulator/index.js') as { DeviceEmulator: typeof DeviceEmulatorType };

export interface ScenarioRunOptions {
    config?: MachineConfig;
    statesController?: StatesControllerType;
}

function assertRequiredChannels(ch: SectionChannelsConfig | undefined): asserts ch is SectionChannelsConfig {
    const missing: string[] = [];
    if (!ch?.Door?.Sensor) missing.push('Door.Sensor');
    if (!ch?.DeliveryBox?.Lock) missing.push('DeliveryBox.Lock');
    if (!ch?.DeliveryBox?.Optic) missing.push('DeliveryBox.Optic');
    if (!ch?.Storage?.MatrixCtrl) missing.push('Storage.MatrixCtrl');
    if (!ch?.Storage?.Tamper?.length) missing.push('Storage.Tamper');
    if (!ch?.Lift?.MotorCtrl) missing.push('Lift.MotorCtrl');
    if (!ch?.Lift?.LevelSensor) missing.push('Lift.LevelSensor');
    if (!ch?.Lift?.BottomTamper) missing.push('Lift.BottomTamper');
    if (!ch?.Lift?.TopTamper) missing.push('Lift.TopTamper');
    if (!ch?.Power?.Current || !ch?.Power?.Voltage || !ch?.Power?.PsuWork) {
        missing.push('Power.{Current,Voltage,PsuWork}');
    }
    if (missing.length > 0) {
        throw new Error(`В конфигурации секции отсутствуют обязательные каналы: ${missing.join(', ')}`);
    }
}

export function resolveMachineAndSectionConfig(
    scenario: NormalizedScenario,
    opts: ScenarioRunOptions
): { config: MachineConfig; secConf: SectionConfig } {
    const config =
        opts.statesController?.Machine.Config ??
        opts.config ??
        (scenario.machineConfig as MachineConfig | undefined);
    if (!config) {
        throw new Error('MachineConfig обязателен для запуска сценария (должен поступать сверху).');
    }
    const secConf = config.Sections.find((s) => String(s.ID) === String(scenario.section.id)) ?? config.Sections[0];
    if (!secConf) {
        throw new Error('В MachineConfig не найдено ни одной секции.');
    }
    assertRequiredChannels(secConf.Channels);
    return { config, secConf };
}

export function createStatesController(
    config: MachineConfig,
    statesOverride?: Record<string, unknown>,
    existing?: StatesControllerType
): StatesControllerType {
    if (existing) return existing;
    const sections = (config.Sections ?? []).map((secConf) => {
        const secState = new SpiralSectionState({
            ...secConf,
            IOList: [],
        });
        secState.ID = secConf.ID;
        return secState;
    });
    const statesController = new StatesController({ portServices: [], sections }, config);
    if (statesOverride) {
        applyDeepPatch(statesController.Machine.States as unknown as Record<string, unknown>, statesOverride);
    }
    return statesController;
}

export function createEmulatorEnv(
    config: MachineConfig,
    secConf: SectionConfig,
    channelsPatch: Record<string, unknown>
): { stub: ProxyChannelStubType; emu: DeviceEmulatorType } {
    const stub = new ProxyChannelStub();
    stub.seed(createInitialChannelsState(config, channelsPatch));
    const emu = new DeviceEmulator({
        ProxyCh: stub,
        channels: secConf.Channels as unknown as Record<string, unknown>,
        size: { rows: secConf.Rows, cols: secConf.Cols },
    });
    return { stub, emu };
}

export function createFacadeEnv(
    secConf: SectionConfig,
    stub: ProxyChannelStubType,
    statesController: StatesControllerType,
    pushEvent: PushTimelineEvent
): ClassVendingSectionFacadeType {
    return new ClassVendingSectionFacade({
        sectionId: secConf.ID,
        ProxyCh: stub,
        StatesController: statesController,
        ProxyLogger: { TransactionID: '', Log: (entry) => pushEvent('log', entry.msg, { level: entry.level }) },
    });
}
