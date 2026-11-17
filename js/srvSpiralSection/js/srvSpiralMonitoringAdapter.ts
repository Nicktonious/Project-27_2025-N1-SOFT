/**
 * SpiralMonitoringAdapter.ts
 *
 * Примитивный адаптер мониторинга моторесурса спиральной секции (srvSpiralSection).
 * Инкапсулирует прямую запись инкрементов моторесурса в каналы ProxyChannel:
 * - monLift: метры перемещения лифта
 * - monSpirals: { Cell, Rots } выдача со спиралей
 * - monBox: циклы открытия/закрытия отсека выдачи
 */

import { TypeProxyCh } from './srvSpiralSection';

export interface SpiralMonitoringAdapterChannels {
    monBox?: string;
    monLift?: string;
    monSpirals?: string;
}

export interface SpiralMonitoringAdapterParams {
    ProxyCh: TypeProxyCh;
    channels?: SpiralMonitoringAdapterChannels;
}

export class SpiralMonitoringAdapter {
    #_ProxyCh: TypeProxyCh;
    #_Channels: SpiralMonitoringAdapterChannels;

    constructor({ ProxyCh, channels = {} }: SpiralMonitoringAdapterParams) {
        if (!ProxyCh) {
            throw new Error('SpiralMonitoringAdapter: ProxyCh обязателен');
        }
        this.#_ProxyCh = ProxyCh;
        this.#_Channels = channels;
    }

    /**
     * Записывает перемещение лифта на заданное расстояние (по умолчанию 0.15 м).
     * @param distance Расстояние перемещения (в метрах)
     */
    RecordLevelPassed(distance: number = 0.15): void {
        if (this.#_Channels.monLift) {
            this.#_ProxyCh.SetValue(this.#_Channels.monLift, distance);
        }
    }

    /**
     * Алиас для RecordLevelPassed (для совместимости)
     */
    RecordLiftOperation(distance: number = 0.15): void {
        this.RecordLevelPassed(distance);
    }

    /**
     * Записывает факт выдачи товара из ячейки спирали.
     * @param cell Индекс ячейки
     * @param rots Количество сделанных оборотов (по умолчанию 1)
     */
    RecordCellDispense(cell: number, rots: number = 1): void {
        if (this.#_Channels.monSpirals) {
            this.#_ProxyCh.SetValue(this.#_Channels.monSpirals, { Cell: cell, Rots: rots });
        }
    }

    /**
     * Записывает срабатывание люка/отсека выдачи (по умолчанию 1).
     * @param value Количество циклов
     */
    RecordBox(value: number = 1): void {
        if (this.#_Channels.monBox) {
            this.#_ProxyCh.SetValue(this.#_Channels.monBox, value);
        }
    }

    RecordBoxDoor(value: number = 1): void {
        this.RecordBox(value);
    }

    RecordBoxLock(value: number = 1): void {
        this.RecordBox(value);
    }
}

export default SpiralMonitoringAdapter;
