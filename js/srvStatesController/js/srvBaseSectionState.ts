'use strict';
// srvBaseSectionState.ts
import EventEmitter2 from 'eventemitter2';
import {
    BaseSectionState as IBaseSectionState,
    TYPE_IO,
    AVAILABLE_STATE,
    SECTION_STATUS,
    LINE_STATE,
    CELL_STATE,
    TRANSACT_STATE,
    IO_STATE,
    IO_PORT_STATE,
    CELL_ACTION
} from '../ts/IBaseSectionStates';
import { SectionConfig } from '../ts/IMachineConfig';

export {
    IBaseSectionState,
    TYPE_IO,
    AVAILABLE_STATE,
    SECTION_STATUS,
    LINE_STATE,
    CELL_STATE,
    TRANSACT_STATE,
    IO_STATE,
    IO_PORT_STATE
};

export type ISectionParams = SectionConfig;

export class BaseSectionState<TCellState extends string = CELL_STATE> extends EventEmitter2 implements Omit<IBaseSectionState, 'Cells'> {
    public Name: string;
    public Type: string;
    public IsAvailable: AVAILABLE_STATE;
    public Status: SECTION_STATUS;
    public Rows: LINE_STATE[];
    public Cols: LINE_STATE[];
    public Cells: { Status: TCellState, Action: CELL_ACTION }[];
    public CellsTransact: TRANSACT_STATE[];
    public Resourse_available: AVAILABLE_STATE[];
    public IO: Record<string, TYPE_IO>;

    constructor(config: ISectionParams) {
        super();
        this.Name = config.Name;
        this.Type = config.Type;
        this.IsAvailable = AVAILABLE_STATE.YES;
        this.Status = SECTION_STATUS.IDLE;
        const rows = (config as SectionConfig).Rows;
        const cols = (config as SectionConfig).Cols;
        this.Rows = Array.from({ length: rows }, () => LINE_STATE.OK);
        this.Cols = Array.from({ length: cols }, () => LINE_STATE.OK);
        this.Cells = Array.from({ length: rows * cols }, 
            () => ({ Status: CELL_STATE.OK as unknown as TCellState, Action: CELL_ACTION.IDLE }));
        this.CellsTransact = Array.from({ length: rows * cols }, () => TRANSACT_STATE.OK);
        this.Resourse_available = Array.from({ length: rows * cols }, () => AVAILABLE_STATE.YES);
        this.IO = (config.IOList ?? []).reduce((pr, ioName) => {
            pr[ioName] = {
                state: IO_STATE.OK,
                name: ioName,
                ports: []
            };
            return pr;
        }, {} as Record<string, TYPE_IO>);
    }

    public Reset(): void {
        const cellCount = this.Cells.length;
        const rowsCount = this.Rows.length;
        const colsCount = this.Cols.length;

        this.IsAvailable = AVAILABLE_STATE.YES;
        this.Status = SECTION_STATUS.IDLE;
        this.Rows = Array.from({ length: rowsCount }, () => LINE_STATE.OK);
        this.Cols = Array.from({ length: colsCount }, () => LINE_STATE.OK);

        for (const ioName of Object.keys(this.IO)) {
            this.IO[ioName] = {
                state: IO_STATE.OK,
                name: ioName,
                ports: []
            };
        }
        this.Cells = Array.from({ length: cellCount }, () => ({ Status: CELL_STATE.OK as unknown as TCellState, Action: CELL_ACTION.IDLE }));
        this.Resourse_available = Array.from({ length: cellCount }, () => AVAILABLE_STATE.YES);
    }
}

export default BaseSectionState;