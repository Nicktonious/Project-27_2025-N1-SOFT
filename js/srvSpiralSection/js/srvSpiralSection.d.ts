import { EventEmitter2 } from "eventemitter2";
import SpiralSectionState from "./srvSpiralSectionStates";

export interface TypeProxyCh {
    SetValue: Function;
    GetValue: Function;
    Value: any;
    Events: EventEmitter2;
}

export interface TypeProxyLogger {
    Log: (args: { level: string; msg: string; obj?: any }) => void;
}

export interface TypeDeliveryBoxChannels {
    lock: string;
    optic: string;
}

export interface TypeSpiralSectionChannels {
    storageChannels: import('./srvSpiralSectionStorage.d.ts').TypeSpiralSectionStorageChannels;
    liftChannels: import('./srvSpiralSectionLift.d.ts').TypeSpiralSectionLiftChannels;
    boxChannels: TypeDeliveryBoxChannels;
    door: string;
    monBox: string;
    monSpirals?: string;
    monLift?: string;
}

export interface TypeSpiralSectionOpts {
    storageOpts: import('./srvSpiralSectionStorage.d.ts').TypeSpiralSectionStorageOpts;
    liftOpts: import('./srvSpiralSectionLift.d.ts').TypeSpiralSectionLiftOpts;
}

export interface TypeSpiralSectionEvents {
    DISPENSE_START: string;
    OPERATION_FINISHED: string;
    UNLOADING_DONE: string;
    DISPENSE_START_MOCK: string;
    ABORT: string;
}

export interface TypeOrder {
    row: number;
    column: number;
    quantity: number;
}

export declare class ClassSpiralSection extends EventEmitter2 {
    static STATE: {
        IDLE: string;
        DISPENSING: string;
        UNLOADING: string;
    };

    constructor(params: {
        ProxyCh: TypeProxyCh;
        channels: TypeSpiralSectionChannels;
        advOpts: TypeSpiralSectionOpts;
        sectionState: SpiralSectionState;
        ProxyLogger?: TypeProxyLogger;
    });

    get InWork(): any;
    get EVENTS(): TypeSpiralSectionEvents;
    get Events(): EventEmitter2;
    set Logger(logger: TypeProxyLogger);

    Init(): void;
    WatchDoor(): void;
    WatchBox(): void;
    Abort(): void;
    Execute(_orders: TypeOrder[]): Promise<any>;
    _Execute(_orders: TypeOrder[]): Promise<any>;
    IsDoorClosed(): boolean;
    Idle(): void;
    Reset(): void;
    HandleDispense(cell: { row: number; column: number }): void;
    HandleFail(cell: { row: number; column: number }, fault: any, message?: string): void;
    HandleErr(e: any, msg: string): void;
    Invoke(methodName: 'Rotate' | string, ...args: any[]): any;
    Deliver(): Promise<any>;
    ManualRotateSpiral(args?: { row: number; column: number; quantity?: number; duration?: number }): any;
    Test_1(fpath: string, level: number, times: number): any;
}