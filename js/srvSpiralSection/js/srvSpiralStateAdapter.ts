/**
 * SpiralStateAdapter.ts
 *
 * Anti-Corruption Layer (ACL) между доменной логикой спиральной секции (srvSpiralSection)
 * и контроллером состояний (srvStatesController).
 *
 * Принципы:
 * 1. Инкапсуляция: код секции оперирует только доменными методами и получает только булевы флаги.
 * 2. Никаких магических строк и приведений `as any`: все поля строго типизированы.
 * 3. Поддержка автономной работы секции при `state == null`.
 */

import { SpiralSectionState } from './srvSpiralSectionStates';
import {
    AVAILABLE_STATE,
    DOOR_STATE,
    SECTION_ACTION,
    SECTION_STATUS,
} from '../../srvStatesController/ts/IBaseSectionStates';
import {
    MEAS_STATE,
    BUS_CURRENT_STATE,
    BusState,
} from '../../srvStatesController/ts/IGlobalStates';
import {
    LIFT_STATE,
    LIFT_ACTION,
    DELIVERY_BOX_STATUS,
    DELIVERY_BOX_ACTION,
    SPIRAL_CELL_STATE,
    CELL_ACTION,
} from '../../srvStatesController/ts/ISpiralSectionStates';

// @ts-ignore
import { FAULTS } from './SpiralSectionConstants';

// Маппинг числовых кодов ошибок в статусы цифрового двойника лифта
const FAULT_TO_LIFT_STATUS: Record<number, LIFT_STATE> = {
    [FAULTS.BOTTOM_TAMPER_FAIL]: LIFT_STATE.ERR_TAMPER,
    [FAULTS.IO_DRIVER_ERR]: LIFT_STATE.BLOCKED,
    [FAULTS.IO_PORT_ERR]: LIFT_STATE.BLOCKED,
    [FAULTS.LEVEL_SENSOR_FAIL]: LIFT_STATE.ERR_LEVEL,
    [FAULTS.LIFT_NO_POWER]: LIFT_STATE.NO_POWER,
    [FAULTS.LIFT_SHORT_CIRCUIT]: LIFT_STATE.SHORT_CIRCUIT,
    [FAULTS.LIFT_OVERLOAD]: LIFT_STATE.OVERLOAD,
    [FAULTS.LIFT_CTRL_UNDEFINED]: LIFT_STATE.BLOCKED,
    [FAULTS.TAMPER_BAD_POS]: LIFT_STATE.ERR_TAMPER,
};

// Маппинг числовых кодов ошибок в статусы люка выдачи
const FAULT_TO_BOX_STATUS: Record<number, DELIVERY_BOX_STATUS> = {
    [FAULTS.IO_DRIVER_ERR]: DELIVERY_BOX_STATUS.BLOCKED,
    [FAULTS.IO_PORT_ERR]: DELIVERY_BOX_STATUS.BLOCKED,
    [FAULTS.ERR_TAMPER]: DELIVERY_BOX_STATUS.ERR_MECHANICAL,
};

// Маппинг числовых кодов ошибок в статусы ячеек матрицы
const FAULT_TO_CELL_STATUS: Record<number, SPIRAL_CELL_STATE> = {
    [FAULTS.ACTUATOR_SHORT_CIRCUIT]: SPIRAL_CELL_STATE.ACTUATOR_SHORT_CIRCUIT,
    [FAULTS.ACTUATOR_NO_POWER]: SPIRAL_CELL_STATE.ACTUATOR_NO_POWER,
    [FAULTS.ERR_TAMPER]: SPIRAL_CELL_STATE.ERR_TAMPER,
    [FAULTS.TAMPER_BAD_POS]: SPIRAL_CELL_STATE.ERR_TAMPER_BAD_POS,
    [FAULTS.IO_DRIVER_ERR]: SPIRAL_CELL_STATE.BLOCKED,
    [FAULTS.IO_PORT_ERR]: SPIRAL_CELL_STATE.BLOCKED,
    [FAULTS.IO_TIMEOUT]: SPIRAL_CELL_STATE.BLOCKED,
};

interface ICellLocalState {
    Status: SPIRAL_CELL_STATE;
    Action: CELL_ACTION;
    Resource: AVAILABLE_STATE;
}

export class SpiralStateAdapter {
    readonly #_State: SpiralSectionState | null;
    readonly #_BusGetter: (() => BusState | null) | null = null;

    // Локальное плоское хранилище для автономного режима (когда state == null)
    #_LiftStatus: LIFT_STATE = LIFT_STATE.OK;
    #_LiftAction: LIFT_ACTION = LIFT_ACTION.IDLE;
    #_LiftResource: AVAILABLE_STATE = AVAILABLE_STATE.YES;

    #_BoxStatus: DELIVERY_BOX_STATUS = DELIVERY_BOX_STATUS.OK;
    #_BoxAction: DELIVERY_BOX_ACTION = DELIVERY_BOX_ACTION.CLOSED;
    #_BoxResource: AVAILABLE_STATE = AVAILABLE_STATE.YES;

    #_DoorState: DOOR_STATE | undefined = undefined;
    #_SectionStatus: SECTION_STATUS = SECTION_STATUS.OK;
    #_SectionAction: SECTION_ACTION = SECTION_ACTION.IDLE;
    #_SectionAvailable: AVAILABLE_STATE = AVAILABLE_STATE.YES;

    #_Cells: Map<number, ICellLocalState> = new Map();

    constructor(
        state?: SpiralSectionState | null,
        { getBusState, busState }: { getBusState?: () => BusState | null; busState?: BusState | null } = {}
    ) {
        this.#_State = state ?? null;
        if (typeof getBusState === 'function') {
            this.#_BusGetter = getBusState;
        } else if (busState) {
            this.#_BusGetter = () => busState;
        }
    }

    // =========================================================================
    // ЛИФТ: БУЛЕВЫ ГЕТТЕРЫ (QUERIES)
    // =========================================================================

    public get IsLiftAvailable(): boolean {
        const status = this.#_GetLiftStatus();
        return status !== LIFT_STATE.SHORT_CIRCUIT && status !== LIFT_STATE.OVERLOAD;
    }

    public get IsLiftOk(): boolean {
        return this.#_GetLiftStatus() === LIFT_STATE.OK;
    }

    public get HasLiftLevelError(): boolean {
        return this.#_GetLiftStatus() === LIFT_STATE.ERR_LEVEL;
    }

    #_GetLiftStatus(): LIFT_STATE {
        return this.#_State ? this.#_State.Lift.Status : this.#_LiftStatus;
    }

    // =========================================================================
    // ЛИФТ: МЕТОДЫ-МУТАЦИИ (COMMANDS)
    // =========================================================================

    public SetLiftMoving(direction: 'UP' | 'DOWN'): void {
        const action = direction === 'UP' ? LIFT_ACTION.MOVING_UP : LIFT_ACTION.MOVING_DOWN;
        this.#_LiftAction = action;
        if (this.#_State) {
            this.#_State.Lift.Action = action;
        }
    }

    public SetLiftIdle(): void {
        this.#_LiftAction = LIFT_ACTION.IDLE;
        if (this.#_State) {
            this.#_State.Lift.Action = LIFT_ACTION.IDLE;
        }
    }

    public SetLiftFault(faultCode: number): void {
        const mappedStatus = FAULT_TO_LIFT_STATUS[faultCode];
        if (mappedStatus) {
            this.#_LiftStatus = mappedStatus;
            if (mappedStatus === LIFT_STATE.SHORT_CIRCUIT || mappedStatus === LIFT_STATE.BLOCKED) {
                this.#_LiftResource = AVAILABLE_STATE.NO;
            }
            if (this.#_State) {
                this.#_State.Lift.Status = mappedStatus;
                if (mappedStatus === LIFT_STATE.SHORT_CIRCUIT || mappedStatus === LIFT_STATE.BLOCKED) {
                    this.#_State.Lift.Resource = AVAILABLE_STATE.NO;
                }
            }
        }
    }

    public SetLiftReady(): void {
        this.#_LiftStatus = LIFT_STATE.OK;
        this.#_LiftAction = LIFT_ACTION.IDLE;
        this.#_LiftResource = AVAILABLE_STATE.YES;
        if (this.#_State) {
            this.#_State.Lift.Status = LIFT_STATE.OK;
            this.#_State.Lift.Action = LIFT_ACTION.IDLE;
            this.#_State.Lift.Resource = AVAILABLE_STATE.YES;
        }
    }

    // =========================================================================
    // СЕРВИСНАЯ ДВЕРЬ И ЛЮК ВЫДАЧИ: БУЛЕВЫ ГЕТТЕРЫ (QUERIES)
    // =========================================================================

    public get IsDoorClosed(): boolean {
        const door = this.#_State ? this.#_State.Door : this.#_DoorState;
        return door === DOOR_STATE.CLOSED || door === undefined;
    }

    public get IsBoxClosed(): boolean {
        const action = this.#_State ? this.#_State.DeliveryBox.Action : this.#_BoxAction;
        return action === DELIVERY_BOX_ACTION.CLOSED;
    }

    // =========================================================================
    // СЕРВИСНАЯ ДВЕРЬ И ЛЮК ВЫДАЧИ: МЕТОДЫ-МУТАЦИИ (COMMANDS)
    // =========================================================================

    public SetDoor(isClosed: boolean): void {
        const door = isClosed ? DOOR_STATE.CLOSED : DOOR_STATE.OPEN;
        this.#_DoorState = door;
        if (this.#_State) {
            this.#_State.Door = door;
        }
    }

    public SetBoxOpen(): void {
        this.#_BoxAction = DELIVERY_BOX_ACTION.OPEN;
        if (this.#_State) {
            this.#_State.DeliveryBox.Action = DELIVERY_BOX_ACTION.OPEN;
        }
    }

    public SetBoxClose(): void {
        this.#_BoxAction = DELIVERY_BOX_ACTION.CLOSED;
        if (this.#_State) {
            this.#_State.DeliveryBox.Action = DELIVERY_BOX_ACTION.CLOSED;
        }
    }

    public SetBoxFault(faultCode: number): void {
        const mappedStatus = FAULT_TO_BOX_STATUS[faultCode];
        if (mappedStatus) {
            this.#_BoxStatus = mappedStatus;
            if (this.#_State) {
                this.#_State.DeliveryBox.Status = mappedStatus;
            }
        }
    }

    public SetBoxReady(): void {
        this.#_BoxStatus = DELIVERY_BOX_STATUS.OK;
        this.#_BoxAction = DELIVERY_BOX_ACTION.CLOSED;
        this.#_BoxResource = AVAILABLE_STATE.YES;
        if (this.#_State) {
            this.#_State.DeliveryBox.Status = DELIVERY_BOX_STATUS.OK;
            this.#_State.DeliveryBox.Action = DELIVERY_BOX_ACTION.CLOSED;
            this.#_State.DeliveryBox.Resource = AVAILABLE_STATE.YES;
        }
    }

    // =========================================================================
    // ШИНА ПИТАНИЯ: БУЛЕВЫ ГЕТТЕРЫ (QUERIES)
    // =========================================================================

    public IsBusOk(): boolean {
        if (!this.#_BusGetter) return true;
        const bus = this.#_BusGetter();
        if (!bus) return true;
        return bus.Voltage === MEAS_STATE.OK && bus.Current === BUS_CURRENT_STATE.OK;
    }

    // =========================================================================
    // СЕКЦИЯ: БУЛЕВЫ ГЕТТЕРЫ (QUERIES)
    // =========================================================================

    public get IsSectionBlocked(): boolean {
        const status = this.#_State ? this.#_State.Status : this.#_SectionStatus;
        return status === SECTION_STATUS.BLOCKED;
    }

    public get IsSectionAvailable(): boolean {
        const avail = this.#_State ? this.#_State.IsAvailable : this.#_SectionAvailable;
        return avail === AVAILABLE_STATE.YES && this.IsBusOk();
    }

    // =========================================================================
    // СЕКЦИЯ: МЕТОДЫ-МУТАЦИИ (COMMANDS)
    // =========================================================================

    public SetSectionDispense(): void {
        this.#_SectionStatus = SECTION_STATUS.DISPENSE;
        this.#_SectionAction = SECTION_ACTION.DISPENSE;
        this.#_SectionAvailable = AVAILABLE_STATE.NO;
        if (this.#_State) {
            this.#_State.Status = SECTION_STATUS.DISPENSE;
            this.#_State.Action = SECTION_ACTION.DISPENSE;
            this.#_State.IsAvailable = AVAILABLE_STATE.NO;
        }
    }

    public SetSectionDelivery(): void {
        this.#_SectionStatus = SECTION_STATUS.DELIVERY;
        if (this.#_State) {
            this.#_State.Status = SECTION_STATUS.DELIVERY;
        }
    }

    public SetSectionBlocked(): void {
        this.#_SectionStatus = SECTION_STATUS.BLOCKED;
        this.#_SectionAvailable = AVAILABLE_STATE.NO;
        if (this.#_State) {
            this.#_State.Status = SECTION_STATUS.BLOCKED;
            this.#_State.IsAvailable = AVAILABLE_STATE.NO;
        }
    }

    public SetSectionIdle(): void {
        this.#_SectionStatus = SECTION_STATUS.IDLE;
        this.#_SectionAction = SECTION_ACTION.IDLE;
        this.#_SectionAvailable = AVAILABLE_STATE.YES;
        if (this.#_State) {
            this.#_State.Status = SECTION_STATUS.IDLE;
            this.#_State.Action = SECTION_ACTION.IDLE;
            this.#_State.IsAvailable = AVAILABLE_STATE.YES;
        }
    }

    // =========================================================================
    // ЯЧЕЙКИ: БУЛЕВЫ ГЕТТЕРЫ (QUERIES)
    // =========================================================================

    #_GetCellStatus(index: number): SPIRAL_CELL_STATE {
        if (this.#_State && this.#_State.Cells && this.#_State.Cells[index]) {
            return (this.#_State.Cells[index].Status as SPIRAL_CELL_STATE) ?? SPIRAL_CELL_STATE.OK;
        }
        return this.#_Cells.get(index)?.Status ?? SPIRAL_CELL_STATE.OK;
    }

    public IsCellAvailable(index: number): boolean {
        const status = this.#_GetCellStatus(index);
        return (
            status === SPIRAL_CELL_STATE.OK ||
            status === SPIRAL_CELL_STATE.ERR_TAMPER ||
            status === SPIRAL_CELL_STATE.ACTUATOR_NO_POWER
        );
    }

    public IsCellCheckable(index: number): boolean {
        const status = this.#_GetCellStatus(index);
        return (
            status === SPIRAL_CELL_STATE.OK ||
            status === SPIRAL_CELL_STATE.ERR_TAMPER_BAD_POS ||
            status === SPIRAL_CELL_STATE.ACTUATOR_NO_POWER
        );
    }

    public IsCellShorted(index: number): boolean {
        return this.#_GetCellStatus(index) === SPIRAL_CELL_STATE.ACTUATOR_SHORT_CIRCUIT;
    }

    public IsCellOk(index: number): boolean {
        return this.#_GetCellStatus(index) === SPIRAL_CELL_STATE.OK;
    }

    public HasCellNoPower(index: number): boolean {
        return this.#_GetCellStatus(index) === SPIRAL_CELL_STATE.ACTUATOR_NO_POWER;
    }

    public HasCellOverload(index: number): boolean {
        const status = this.#_GetCellStatus(index);
        return status === SPIRAL_CELL_STATE.OVERLOAD_I || status === SPIRAL_CELL_STATE.OVERLOAD;
    }

    // =========================================================================
    // ЯЧЕЙКИ: МЕТОДЫ-МУТАЦИИ (COMMANDS)
    // =========================================================================

    #_GetOrCreateLocalCell(index: number): ICellLocalState {
        let cell = this.#_Cells.get(index);
        if (!cell) {
            cell = {
                Status: SPIRAL_CELL_STATE.OK,
                Action: CELL_ACTION.IDLE,
                Resource: AVAILABLE_STATE.YES,
            };
            this.#_Cells.set(index, cell);
        }
        return cell;
    }

    public SetCellDispenseStart(index: number): void {
        const cell = this.#_GetOrCreateLocalCell(index);
        cell.Action = CELL_ACTION.ACTION;
        if (this.#_State && this.#_State.Cells && this.#_State.Cells[index]) {
            this.#_State.Cells[index].Action = CELL_ACTION.ACTION;
        }
    }

    public SetCellDispenseEnd(index: number): void {
        const cell = this.#_GetOrCreateLocalCell(index);
        cell.Action = CELL_ACTION.IDLE;
        if (this.#_State && this.#_State.Cells && this.#_State.Cells[index]) {
            this.#_State.Cells[index].Action = CELL_ACTION.IDLE;
        }
    }

    public SetCellFault(index: number, faultCode: number): void {
        const mappedStatus = FAULT_TO_CELL_STATUS[faultCode];
        if (mappedStatus) {
            const cell = this.#_GetOrCreateLocalCell(index);
            cell.Status = mappedStatus;
            if (mappedStatus === SPIRAL_CELL_STATE.ACTUATOR_SHORT_CIRCUIT) {
                cell.Resource = AVAILABLE_STATE.NO;
            }
            if (this.#_State && this.#_State.Cells && this.#_State.Cells[index]) {
                this.#_State.Cells[index].Status = mappedStatus;
                if (mappedStatus === SPIRAL_CELL_STATE.ACTUATOR_SHORT_CIRCUIT) {
                    this.#_State.Cells[index].Resource = AVAILABLE_STATE.NO;
                }
            }
        }
    }

    public SetCellOk(index: number): void {
        const cell = this.#_GetOrCreateLocalCell(index);
        cell.Status = SPIRAL_CELL_STATE.OK;
        if (this.#_State && this.#_State.Cells && this.#_State.Cells[index]) {
            this.#_State.Cells[index].Status = SPIRAL_CELL_STATE.OK;
        }
    }

    public SetCellOverload(index: number): void {
        const cell = this.#_GetOrCreateLocalCell(index);
        cell.Status = SPIRAL_CELL_STATE.OVERLOAD_I;
        if (this.#_State && this.#_State.Cells && this.#_State.Cells[index]) {
            this.#_State.Cells[index].Status = SPIRAL_CELL_STATE.OVERLOAD_I;
        }
    }

    public ClearCellsOverload(): void {
        // Сброс перегрузки в локальном хранилище
        for (const cell of this.#_Cells.values()) {
            if (cell.Status === SPIRAL_CELL_STATE.OVERLOAD_I) {
                cell.Status = SPIRAL_CELL_STATE.OK;
            }
        }
        // Сброс перегрузки в инжектированном состоянии
        if (this.#_State && this.#_State.Cells) {
            for (const cell of this.#_State.Cells) {
                if (cell && (cell.Status as SPIRAL_CELL_STATE) === SPIRAL_CELL_STATE.OVERLOAD_I) {
                    cell.Status = SPIRAL_CELL_STATE.OK;
                }
            }
        }
    }

    public SetCellReady(index: number): void {
        const cell = this.#_GetOrCreateLocalCell(index);
        cell.Status = SPIRAL_CELL_STATE.OK;
        cell.Action = CELL_ACTION.IDLE;
        cell.Resource = AVAILABLE_STATE.YES;
        if (this.#_State && this.#_State.Cells && this.#_State.Cells[index]) {
            this.#_State.Cells[index].Status = SPIRAL_CELL_STATE.OK;
            this.#_State.Cells[index].Action = CELL_ACTION.IDLE;
            this.#_State.Cells[index].Resource = AVAILABLE_STATE.YES;
        }
    }

    // =========================================================================
    // СБРОС (RESET)
    // =========================================================================

    public Reset(): void {
        this.#_LiftStatus = LIFT_STATE.OK;
        this.#_LiftAction = LIFT_ACTION.IDLE;
        this.#_LiftResource = AVAILABLE_STATE.YES;

        this.#_BoxStatus = DELIVERY_BOX_STATUS.OK;
        this.#_BoxAction = DELIVERY_BOX_ACTION.CLOSED;
        this.#_BoxResource = AVAILABLE_STATE.YES;

        this.#_DoorState = undefined;
        this.#_SectionStatus = SECTION_STATUS.OK;
        this.#_SectionAction = SECTION_ACTION.IDLE;
        this.#_SectionAvailable = AVAILABLE_STATE.YES;

        this.#_Cells.clear();

        if (this.#_State) {
            this.#_State.Reset();
        }
    }
}

export default SpiralStateAdapter;
