import { EventEmitter2 } from "eventemitter2";
import { TypeProxyCh } from "./srvSpiralSection";
import SpiralSectionState from "./srvSpiralSectionStates";
import StatesController from "../../srvStatesController/js/srvSectionStateController";

export interface TypeSpiralSectionStorageChannels {
    matrixCtrlChannel: string;
    spiralTamperChannels: string[];
    current: string;
    voltage: string;
    short: string;
    psuWork: string;
    monSpirals: string;
}

export interface TypeSpiralSectionStorageOpts {
    busNumber: number;
    size: {
        rows: number;
        cols: number;
    };
    globalState: StatesController;
}

export interface TypeSpiralSectionUnitOpts {
    index: number;
    coords: TypeCoords;
    tamperInd: number;
}

export interface TypeSpiralSectionUnitEvents {
    DISPENSE_COMMAND: string;
    DISPENSED_SINGLE: string;
    COMPLETED: string;
    ROTATE_TIMEOUT: string;
    FAULT: string;
    DISPENSE_RESULT: string;
    RECOVERED: string;
    TEST_COMMAND: string;
    TEST_DONE: string;
    RUN_MOTOR_COMMAND: string;
    RUN_MOTOR_DONE: string;
}

export interface TypeUnit {
    index: number;
    coords: TypeCoords;
    capacity: number;
    itemsLoaded: number;
    itemsLeft: number;
    itemsRequested?: number;
    itemsDispensed: number;
    status: string;
    tamperInd: number;
    isOn: boolean;
}

export interface TypeOrderContext {
    unitIndex: number;
    itemsRequested: number;
    itemsDispensed: number;
    manual: boolean;
    aborted: boolean;
}

export interface TypeTask {
    res: Function;
    rej: Function;
}

export interface TypeSpiralSectionContext {
    rows: number;
    cols: number;
    currentOrder: TypeOrderContext | null;
    units: TypeUnit[];
    dispenseTimer?: import('./srvUtils').TypeTimer | null;
    fallbackTimer?: import("./srvUtils").TypeTimer | null;
    currentTask?: TypeTask | null;
}

export interface TypeCoords {
    col: number;
    row: number;
}

export interface TypeElectrCurrentState {
    IDLE: string;
    WORK_OK: string;
    STUCK: string;
    SHORT: string;
}

export declare class ClassSpiralSectionStorage {
    static STATE: {
        IDLE: string;
        DISPENSING: string;
        FAULT: string;
        TESTING: string;
        RUNNING_MOTOR: string;
    };

    constructor(params: {
        ProxyCh: TypeProxyCh;
        channels: TypeSpiralSectionStorageChannels;
        advOpts: TypeSpiralSectionStorageOpts;
        sectionState: SpiralSectionState;
    });

    get EVENTS(): TypeSpiralSectionUnitEvents;
    get Events(): EventEmitter2;
    get MaxLevel(): number;
    get State(): string;

    IsCheckable(coords: { row: number; column: number }): boolean;

    RowIterator(rowIndex: number): Generator<TypeUnit, void, unknown>;
    RowIndexIterator(rowIndex: number): Generator<TypeUnit, void, unknown>;
    ColIterator(colIndex: number): Generator<TypeUnit, void, unknown>;

    Init(): void;
    InitEventHandlers(): void;
    SetTamperHandlers(): void;
    SetCurrentHandler(): void;
    SetVoltageHandler(): void;
    StartPSUWatch(): void;
    OnStateChanged(...args: any[]): void;
    OnDispensedSingle(param: { tamperInd: number }): Promise<void>;
    OnTimeout(param: { index: number }): Promise<void>;
    OnCompleted(): void;
    OnFault(fault: any): Promise<void>;
    Idle(): Promise<void>;
    EmergencyOff(): void;
    Dispense(order: import("./srvSpiralSection").TypeOrder, test?: boolean): Promise<void>;
    TestSpiral(order: import("./srvSpiralSection").TypeOrder): Promise<void>;
    RunMotor(param: { row: number; column: number, duration: number }): Promise<void>;

    _Dispense(order: import("./srvSpiralSection").TypeOrder, test?: boolean): Promise<void>;
    _RunMotor(param: { row: number; column: number; duration: number }): Promise<void>;

    CheckCurrentState(currVal?: number): string | undefined;
    UnitsByScope(index: number, scope: 'single' | 'row' | 'col' | 'all'): Generator<TypeUnit, void, unknown>;
    UpdateStorageContext(
        param0: { index: number },
        param1: {
            dispensed?: number;
            scope?: 'single' | 'row' | 'col' | 'all';
            status?: string;
            except?: string[];
        }
    ): void;
    GetStorageInfo(param0: { index: number }): TypeUnit | null;
    SetOutOfService(): void;
    MotorOnPhased(index: number): Promise<void>;
    MotorOff(index: number, param1?: { force?: boolean }): Promise<void>;
    MotorStep(cmd: 'On' | 'Off', param1: { index: number; step?: number }): Promise<void>;
    _TestSpiral(coords: { row: number; column: number }): Promise<void>;
    MotorOffPhased(index: number): Promise<void>;
    OffEmergency(): Promise<void>;
    IsShorted(): boolean;
    IndexToPos(index: number, _width?: number): { row: number; col: number };
    PosToInd(coords: { row: number; col: number }): number;
    GetLevelByIndex(index: number): number;
    UpdateStatus(fault: any): void;
    Abort(): void;
    Reset(): void;
}