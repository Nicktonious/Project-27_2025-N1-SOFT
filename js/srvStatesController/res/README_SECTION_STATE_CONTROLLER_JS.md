<div style="font-family: 'Open Sans', sans-serif; font-size: 16px">

# StatesController ([srvSectionStateController.ts](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/js/srvSectionStateController.ts))

<div style="color: #555">
<p align="center">
<!-- <img src="./res/logo.png" width="400" title="hover text"> -->
</p>
</div>

## Лицензия
////

### Описание
Класс `StatesController` реализует центральный контроллер состояний аппарата. Он объединяет динамические состояния ([`States`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/ts/IGlobalStates.ts)), телеметрию наработки и датчиков ([`Monitoring`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/ts/IGlobalMonitoring.ts)) и аппаратную конфигурацию ([`Config`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/ts/IMachineConfig.ts)) в единое реактивное дерево `Machine`.

Контроллер оборачивает дерево состояний в глубокий прокси с помощью [`createReactiveState`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/js/srvReactiveProxy.ts), отслеживает любые мутации свойств и автоматически транслирует их внешним сервисам через интерфейс [`IPortService`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/js/srvSectionStateController.ts#L37-L42) (например, брокер MQTT). Также контроллер поддерживает двунаправленную синхронизацию, принимая внешние изменения состояния и применяя их к локальному дереву с защитой от эхо-циклов.

Поддерживает строгую типизацию секций аппарата через TypeScript Generics (`TSection extends BaseSectionState<any>`).

---

### Подписки (Внутренние события EventEmitter)
Класс наследуется от `EventEmitter2` и подписывается на событие мутации дерева состояний:
- `update` — генерируется при изменении свойств в реактивном дереве `Machine`.
  Структура события ([`IEventStateUpdate`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/js/srvSectionStateController.ts#L49-L54)):
  ```typescript
  export interface IEventStateUpdate {
      path: string[];   // Массив ключей пути к свойству (например, ['States', 'Command'])
      topic?: string;   // Сформированный топик пути ('States/Command')
      state: any;       // Новое значение свойства
      init?: boolean;   // Флаг первичной инициализации дерева
  }
  ```

---

### Внешнее взаимодействие (через `IPortService`)
Контроллер взаимодействует с внешними шинами и брокерами сообщений через массив сервисов порта [`IPortService`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/js/srvSectionStateController.ts#L37-L42):
- `service.Init()` — асинхронная инициализация порта (подключение к брокеру/серверу).
- `service.Sub(`${this.rootTopic}/#`)` — подписка на все входящие сообщения корневого топика (по умолчанию `Machine/#`).
- `service.on('message', ({ topic, payload }) => ...)` — обработка входящих изменений и передача их в метод `ApplyExternalState`.
- `service.Pub(fullTopic, state)` — отправка изменений наружу (топик формата `Machine/<path>`).
- `service.ClearRetained?()` — опциональная очистка retained-сообщений брокера при сбросе состояния.

---

### Интерфейсы и структуры данных

#### `IPortService`
```typescript
export interface IPortService extends EventEmitter2 {
    Init(): Promise<void>;
    Pub(topic: string, state: string, opts?: object): void;
    Sub(topic: string): void;
    ClearRetained?(): void;
}
```

#### `IConstructorParams<TSection>`
```typescript
export interface IConstructorParams<TSection extends BaseSectionState<any> = BaseSectionState<any>> {
    sections?: TSection[];        // Экземпляры классов секций (унаследованные от BaseSectionState)
    portServices?: IPortService[]; // Сервисы обмена данными (MQTT, Redis и т.д.)
}
```

#### `IRootState<TSection>`
Единая структура корневого состояния аппарата:
```typescript
export interface IRootState<TSection extends BaseSectionState<any> = BaseSectionState<any>> {
    States: Omit<GlobalStates, 'Sections'> & {
        Sections: TSection[];
    };
    Monitoring: GlobalMonitoring;
    Config: MachineConfig;
}
```

---

### Поля класса

<div style="color: #555">

- `public Machine: IRootState<TSection>` — единое дерево состояния, мониторинга и конфигурации аппарата, обернутое в реактивный Proxy.
- `private portServices: IPortService[]` — массив подключенных сервисов публикации/подписки.
- `private _isApplyingExternal: boolean = false` — флаг защиты от бесконечных циклов публикации (эхо) при обновлении извне.
- `readonly rootTopic: string = 'Machine'` — базовый префикс для формирования топиков в брокерах.

</div>

---

### Конструктор

```typescript
constructor(opts: IConstructorParams<TSection>, config: MachineConfig)
```

**Порядок инициализации:**
1. Сохраняет и инициализирует порты `opts.portServices`, выполняет `service.Init()`, подписывается на топики `Machine/#` и регистрирует обработчик сообщений `message`.
2. Создает исходное дерево `rawState: IRootState<TSection>`:
   - **`States`**: инициализирует идентификаторы аппарата из `config.Global`, режим работы, статусы питания шин и блоков питания (`Power.Bus`, `Power.PSU`), сетевые компоненты (`Net`) и массив секций `opts.sections`.
   - **`Monitoring`**: инициализирует глобальные счетчики наработки и мощности, мониторинг шин, БП, а также наработку и ячейки секций из `config.Sections`.
   - **`Config`**: сохраняет неизменяемую конфигурацию аппарата `config`.
3. Подписывается на внутреннее событие `'update'` реактивного дерева: при изменении поля вызывает `onUpdate`, которое отправляет топик `Machine/<path>` во все `portServices` (если в данный момент не активен флаг `_isApplyingExternal`).
4. Оборачивает `rawState` через утилиту [`createReactiveState(rawState, this)`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/js/srvReactiveProxy.ts) и сохраняет в поле `this.Machine`.
5. Рекурсивно обходит начальное состояние с помощью `emitInitialTree(rawState)`, отправляя начальные значения всех листьев дерева с флагом `init: true`.

---

### Методы

<div style="color: #555">

- **`ApplyExternalState(topic: string, payload: any): void`**  
  Применяет внешнее изменение состояния (из MQTT/Redis). Отрезает префикс `rootTopic`, парсит путь по разделителю `/`, преобразует простые типы (`number`, `'true'`/`'false'`) и безопасно записывает значение в реактивное дерево `Machine`. Защищает от засорения дерева, проверяя существование свойств перед записью.

- **`Destroy(): void`**  
  Отписывается от всех слушателей внутреннего события `'update'`.

- **`Reset(): void`**  
  Вызывает метод `Reset()` у всех зарегистрированных секций в `this.Machine.States.Sections` и очищает retained-сообщения во внешних брокерах через `port.ClearRetained?.()`.

- **`private emitInitialTree(obj: any, basePath: string[] = []): void`**  
  Рекурсивный обход дерева объектов. Пропускает приватные свойства (начинающиеся с `_`) и методы. Для каждого скалярного листа генерирует событие `'update'` с пометкой `init: true`.

- **`private onUpdate({ prop, state }: { prop: string, state: any }): void`**  
  Формирует полный топик вида `${this.rootTopic}/${prop}` и публикует строковое представление значения во все зарегистрированные `portServices`.

</div>

---

### Пример использования

```typescript
import { MqttPortService } from './srvMQTTPortService';
import StatesController from './srvSectionStateController';
import SpiralSectionState from './srvSpiralSectionState';
import { MachineConfig } from '../ts/IMachineConfig';
import { GLOBAL_MACHINE_STATE, CELL_STATE } from '../ts/IGlobalStates';

// 1. Конфигурация аппарата (MachineConfig)
const machineConfig: MachineConfig = {
    Global: {
        ID: 'VM-001',
        Model: 'SnackMaster',
        StartDate: '2026-01-01'
    },
    Power: {
        Bus: [{ Voltage: 24 }],
        PSU: [{ VoltageIn: 230, VoltageOut: 24 }]
    },
    Sections: [
        { Name: 'Spiral_1', Type: 'SPIRAL', Rows: 6, Cols: 10 }
    ]
};

// 2. Инициализация секций и сервисов портов
const mqttService = new MqttPortService('mqtt://127.0.0.1:1883', 'client-1');
const spiralSection = new SpiralSectionState({ Name: 'Spiral_1', Rows: 6, Cols: 10 });

// 3. Создание контроллера состояний
const controller = new StatesController({
    sections: [spiralSection],
    portServices: [mqttService]
}, machineConfig);

// 4. Реактивное изменение состояния
// Автоматически публикует в MQTT топик "Machine/States/Mode" со значением "SERVICE"
controller.Machine.States.Mode = GLOBAL_MACHINE_STATE.SERVICE;

// Доступ к строго типизированным секциям
controller.Machine.States.Sections[0].Cells[0] = CELL_STATE.OK;
```

</div>