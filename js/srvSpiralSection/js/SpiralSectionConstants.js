const COMMON_CONSTANTS = {
    MIN_VOLTAGE: 16,
    SPIRAL_SAFE_MODE: true
}
const STORAGE_CONSTANSTS = {
    SHORT_CH_VAL: 1,
    POWER_OFF_CH_VAL: 1,

    TAMPER_ON: 0,
    TAMPER_OFF: 1,
    TAMPER_UNDEFINED: 0,

    AVG_ROTATION_TIME: 3000,
    FULL_ROTATION_TIMEOUT: 4000,
    TAMPER_DEBOUNCE: 500,

    MONITOR_INTERVAL: 400,

    CURRENT_RANGE: {
        IDLE: [0, 0.15],
        WORK_OK: [0.15, 0.25],
        OVERLOAD: [0.3, 1.4],
        SHORT: [1.4, Infinity]
    },

    VOLTAGE_RANGE: {
        IDLE: [0, 0.3],
        WORK_OK: [0.3, 0.21],
        OVERLOAD: [0.21, 1],
        SHORT: [1, Infinity]
    },

    ELECTR_CURR_STATE: {
        IDLE: 'IDLE',
        WORK_OK: 'WORK_OK',
        OVERLOAD: 'STUCK',
        SHORT: 'SHORT'
    },

    SUPPLY_VOLTAGE: 24,
    SUPPLY_VOLTAGE_UPPER_LIM: 25,
    SUPPLY_VOLTAGE_LOWER_LIM: 23
}
const LIFT_CONSTANTS = {
    LIFT_LEVEL_ON: 1,
    LIFT_LEVEL_OFF: 0,

    LIFT_BOTTOM_TAMPER_ON: 1,
    LIFT_BOTTOM_TAMPER_OFF: 0,
    LIFT_BOTTOM_TAMPER_DEBOUNCE: 500,

    DOUBLE_TRIGGER_WINDOW: 100,

    ELEVATE_NEXT_AVG_TIME: 900,
    ELEVATE_NEXT_OVERLOAD_TIME: 1000,
    ELEVATE_NEXT_MAX_TIME: 2000,

    MOTOR_RES_MAX_TIME: 500,
    MONITOR_INTERVAL: 200,

    CURRENT_RANGE: {
        IDLE: [0, 0.08],
        WORK_OK: [0.08, 2],
        OVERLOAD: [2, 5],
        SHORT: [5, Infinity]
    },

    ELECTR_CURR_STATE: {
        IDLE: 'IDLE',
        WORK_OK: 'WORK_OK',
        OVERLOAD: 'STUCK',
        SHORT: 'SHORT'
    },

    WORK_VOLTAGE: 24
}

const BOX_CONSTANTS = {
    UNLOCKED_TIMEOUT_SEC: 20,
    DOOR_CLOSED: 1,
    BOX_CLOSED: 1,
    UNLOCK_ON: 1,
    UNLOCK_OFF: 0,
}

const FAULTS = {
    NONE: 0,

    LIFT_SHORT_CIRCUIT: 1,
    LIFT_NO_POWER: 2,
    LIFT_OVERLOAD: 3,
    LIFT_OVERLOAD_1: 31,
    LIFT_OVERLOAD_2: 32,
    LIFT_CTRL_UNDEFINED: 4,

    LEVEL_SENSOR_FAIL: 5,
    BOTTOM_TAMPER_FAIL: 6,

    ACTUATOR_NO_POWER: 7,
    ACTUATOR_SHORT_CIRCUIT: 8,
    ERR_TAMPER: 9,
    TAMPER_BAD_POS: 19,
    ACTUATOR_OVERLOAD: 10,
    ACTUATOR_OVERLOAD_1: 11,
    ACTUATOR_OVERLOAD_2: 12,

    IO_DRIVER_ERR: 13,
    IO_TIMEOUT: 14,
    IO_PORT_ERR: 15,
    IO_PORT_ERR_1: 16,
    IO_PORT_ERR_2: 17,

    FALLBACK_TIMEOUT: 18,
    DOOR_OPENED: 20
};

const CELL_CONSTANTS = {
    TAMPER_ON: 1,
    TAMPER_OFF: 0,

    LOCK_ON: 1,
    LOCK_OFF: 0,
    UNLOCK_TIMEOUT: 50,

    ELECTR_CURR_STATE: {
        IDLE: 'IDLE',
        WORK_OK: 'WORK_OK',
        OVERLOAD: 'STUCK',
        SHORT: 'SHORT'
    },

    CURRENT_RANGE: {
        // [a, b)
        IDLE: [0, 2.8],
        WORK_OK: [2.8, 3.2],
        OVERLOAD: [3.2, 3.75],
        SHORT: [3.75, Infinity]
    }
}

const FAULT_DESC_RU = {
    [FAULTS.NONE]: "Нет ошибки",
    [FAULTS.LIFT_SHORT_CIRCUIT]: "Короткое замыкание двигателя лифта",
    [FAULTS.LIFT_NO_POWER]: "Отсутствует питание двигателя лифта",
    [FAULTS.LIFT_OVERLOAD]: "Перегрузка двигателя лифта",
    [FAULTS.LIFT_CTRL_UNDEFINED]: "Неопределённое состояние управления лифтом",

    [FAULTS.LEVEL_SENSOR_FAIL]: "Отказ датчика уровня",
    [FAULTS.BOTTOM_TAMPER_FAIL]: "Отказ нижнего тампера",
    [FAULTS.TAMPER_BAD_POS]: "Одна из спиралей находится в некорректном начальном положении",
    [FAULTS.ACTUATOR_NO_POWER]: "Отсутствует питание актуатора",
    [FAULTS.ACTUATOR_SHORT_CIRCUIT]: "Короткое замыкание актуатора",
    [FAULTS.ERR_TAMPER]: "Ошибка сигнала тампера",
    [FAULTS.ACTUATOR_OVERLOAD]: "Перегрузка актуатора",

    [FAULTS.IO_DRIVER_ERR]: "Ошибка драйвера ввода-вывода",
    [FAULTS.IO_TIMEOUT]: "Таймаут обмена с устройством ввода-вывода",
    [FAULTS.IO_PORT_ERR]: "Ошибка порта ввода-вывода",

    [FAULTS.FALLBACK_TIMEOUT]: "Выполнение команды прервано из за превышения ожидаемого таймаута",
    [FAULTS.DOOR_OPENED]: "Дверь открыта, выполнение транзакции заблокировано"
}

const U_TRANSACTIONS = {
    ACTUATOR_CONNECT_GND: 'Подключение актуатора к Gnd',
    ACTUATOR_CONNECT_V_PLUS: 'Подключение актуатора к V+',
    ACTUATOR_DISCONNECT_GND: 'Отключение актуатора от Gnd',
    ACTUATOR_DISCONNECT_V_PLUS: 'Отключение актуатора от V+',

    LIFT_REV: 'Включения лифта для движения вниз',
    LIFT_DISCONNECT_GND_REV: 'Отключение лифта от Gnd/Reverse',
    LIFT_CONNECT_V_PLUS_REV: 'Подключение лифта к V+/Reverse',
    LIFT_STOP_AFTER_REV: 'Выключение лифта после движения вниз',

    LIFT_FWD: 'Включение лифта для движения вверх',
    LIFT_DISCONNECT_GND_FWD: 'Отключение лифта от Gnd/Forward',
    LIFT_CONNECT_V_PLUS_FWD: 'Подключение лифта к V+/Forward',
    LIFT_STOP_AFTER_FWD: 'Выключение лифта после движения вверх'
};

module.exports = { COMMON_CONSTANTS, STORAGE_CONSTANSTS, LIFT_CONSTANTS, BOX_CONSTANTS, CELL_CONSTANTS, FAULTS, FAULT_DESC_RU, U_TRANSACTIONS };
