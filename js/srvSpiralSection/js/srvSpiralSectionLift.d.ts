export interface TypeSpiralSectionLiftChannels {
    liftMotorCtrl2: string?;
    liftMotorCtrl: string;
    liftBottomTamper: [string];
    liftTopTamper: [string];
    liftLevelSensor: string;
    current: string;
    voltage: string;
    short: string;
    psuWork: string;
    monLift: string;
}

export interface TypeSpiralSectionLiftOpts {
    maxLevel: number;
    busNumber: number;
}

export interface TypeSpiralSectionLiftEvents {
    IDLE: string;
    ELEVATE_TO_BASE_COMMAND: string;
    ELEVATE_TO_BOTTOM_COMMAND: string;
    BOTTOM_LEVEL_REACHED: string;
    COLLECT_LEVEL_REACHED: string;
    BASE_LEVEL_REACHED: string;
    ELEVATE_COMMAND: string;
    ELEVATE_TIMEOUT: string;
    FAULT: string;
    RECOVERED: string;
    ABORT: string;
}

export interface TypeTask {
    res: Function;
    rej: Function;
}

export interface TypeSpiralSectionLiftContext {
    currentLevel: number | undefined;
    requiredLevel: number | undefined;
    currentTask: TypeTask;
    timer: import("./srvUtils").TypeTimer;
    fallbackTimer: import("./srvUtils").TypeTimer;
    movingDir:  -1 | 0 | 1;
    motorTransition: boolean;
}

import { ClassFSM as FSM } from "./srvFSM";

declare class ClassSpiralSectionLift extends EventEmitter2<TypeSpiralSectionLiftEvents> {
    constructor(channels: TypeSpiralSectionLiftChannels, opts: TypeSpiralSectionLiftOpts);
    #_FSM: FSM;
    get State(): string;
    get Status(): string;
    get Level(): string;
    get Available(): boolean;

    Init(): void;
    Idle(): Promise<void>;
    ElevateToLevel(level: number): Promise<void>;
    ElevateToBottom(): Promise<void>;
    ElevateToBase(): Promise<void>;
    Abort(): void;
}