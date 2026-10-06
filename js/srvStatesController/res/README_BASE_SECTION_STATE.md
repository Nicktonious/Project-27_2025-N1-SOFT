<div style="font-family: 'Open Sans', sans-serif; font-size: 16px">

# BaseSectionState ([srvBaseSectionState.ts](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/js/srvBaseSectionState.ts))

<div style="color: #555">
<p align="center">
<!-- <img src="./res/logo.png" width="400" title="hover text"> -->
</p>
</div>

## Лицензия
////

### Описание
Класс [`BaseSectionState`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/js/srvBaseSectionState.ts#L32-L88) представляет собой базовую модель состояния секции вендингового аппарата. Он инкапсулирует статус доступности, состояние строк (полок), столбцов, ячеек, транзакций и периферийных модулей ввода-вывода (IO).

Класс наследуется от `EventEmitter2` и реализует интерфейс `Omit<IBaseSectionState, 'Cells'>`. Благодаря параметризации через дженерик `BaseSectionState<TCellState extends string = CELL_STATE>` обеспечивается строгая типизация и возможность расширения набора допустимых состояний ячеек в специализированных подклассах секций (например, в спиральных секциях).

---

### Источник типов и перечислений (JSON Schema -> TypeScript)
Все используемые перечисления (`enums`) и интерфейсы состояний **не объявляются вручную**, а генерируются утилитой `json2ts` из JSON-схем:

1. **Состояния базовой секции:**  
   Схема [`base_section_states.schema.json`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/schema/MachineState/base_section_states.schema.json) транслируется в файл [`IBaseSectionStates.ts`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/ts/IBaseSectionStates.ts), откуда импортируются перечисления:
   - `AVAILABLE_STATE` — статус доступности (`YES`, `NO`);
   - `SECTION_STATUS` — рабочий статус секции (`IDLE`, `DISPENSE`, `DELIVERY`, `BLOCKED`, `LOADING`);
   - `LINE_STATE` — статус строк и столбцов (`OK`, `BLOCKED`);
   - `CELL_STATE` — базовые статусы ячеек (`OK`, `OVERLOAD_I`, `OVERLOAD_V`, `BLOCKED`, `ERROR`, `SERVICE`, `ERR_TAMPER`, `ERR_TAMPER_BAD_POS`, `ACTUATOR_SHORT_CIRCUIT`, `ACTUATOR_NO_POWER`, `ERR_MECHANICAL`);
   - `CELL_ACTION` — состояние выполнения действия ячейки (`IDLE`, `ACTION`, `OPEN`, `NOT_CLOSED`);
   - `TRANSACT_STATE` — транзакционный статус ячейки (`OK`, `EXECUTING`, `COMPLETED`, `WARNING`);
   - `IO_STATE` — статус модуля ввода-вывода (`OK`, `ERR_NO_LINK`);
   - `IO_PORT_STATE` — статус порта ввода-вывода (`OK`, `ERROR`);
   - `TYPE_IO` — структура состояния модуля ввода-вывода;
   - `DOOR_STATE` — состояние сервисной двери (`CLOSED`, `OPEN`);
   - `COMMAND_STATE` — состояние выполнения команд (`IDLE`, `COMMAND`, `BLOCKED`);
   - `BaseSectionState as IBaseSectionState` — контракт базовой секции.

2. **Конфигурация секции:**  
   Схема [`sections.schema.json`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/schema/MachineConfig/sections.schema.json) транслируется в [`IMachineConfig.ts`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/ts/IMachineConfig.ts), откуда берутся перечисление `SECTION_TYPE` (`POST`, `SPIRAL`, `WEIGHT`, `DOZER`) и интерфейс `SectionConfig` (`type ISectionParams = SectionConfig`).

---

### Поля класса

<div style="color: #555">

- `public Name: string` — имя секции (например, `'Spiral_Upper'`).
- `public Type: string` — тип секции (`SECTION_TYPE`, например `'SPIRAL'`).
- `public IsAvailable: AVAILABLE_STATE` — общая доступность секции (`YES` / `NO`).
- `public Status: SECTION_STATUS` — текущий рабочий статус секции (`IDLE`, `DISPENSE` и т.д.).
- `public Rows: LINE_STATE[]` — массив состояний полок секции (длина равна `Rows`, значения `OK` / `BLOCKED`).
- `public Cols: LINE_STATE[]` — массив состояний колонок секции (длина равна `Cols`, значения `OK` / `BLOCKED`).
- `public Cells: { Status: TCellState, Action: CELL_ACTION }[]` — одномерный массив ячеек размера `Rows * Cols`, содержащий статус ячейки и текущее действие.
- `public CellsTransact: TRANSACT_STATE[]` — массив статусов транзакций ячеек (размер `Rows * Cols`).
- `public Resourse_available: AVAILABLE_STATE[]` — флаги доступности моторесурса ячеек (размер `Rows * Cols`).
- `public IO: Record<string, TYPE_IO>` — словарь подключенных модулей ввода-вывода с их портами и состояниями.

</div>

---

### Конструктор

```typescript
constructor(config: ISectionParams)
```

**Логика инициализации:**
- Принимает конфигурацию секции `config` типа [`SectionConfig`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/ts/IMachineConfig.ts).
- Устанавливает свойства `Name` и `Type`.
- Выставляет `IsAvailable` в `AVAILABLE_STATE.YES`, а `Status` в `SECTION_STATUS.IDLE`.
- Инициализирует массивы `Rows` (длиной `config.Rows`) и `Cols` (длиной `config.Cols`) значениями `LINE_STATE.OK`.
- Формирует массивы ячеек размером `Rows * Cols`:
  - `Cells` заполняется объектами `{ Status: CELL_STATE.OK, Action: CELL_ACTION.IDLE }`;
  - `CellsTransact` заполняется `TRANSACT_STATE.OK`;
  - `Resourse_available` заполняется `AVAILABLE_STATE.YES`.
- Инициализирует словарь модулей ввода-вывода `IO` из переданного списка `config.IOList`.

---

### Методы

<div style="color: #555">

- **`Reset(): void`**  
  Сбрасывает все поля секции к эталонным начальным состояниям:
  - `IsAvailable = AVAILABLE_STATE.YES`
  - `Status = SECTION_STATUS.IDLE`
  - Все элементы `Rows` и `Cols` сбрасываются в `LINE_STATE.OK`
  - Все модули в словаре `IO` переводятся в `IO_STATE.OK`
  - Все ячейки `Cells` сбрасываются в `{ Status: CELL_STATE.OK, Action: CELL_ACTION.IDLE }`
  - Массив `Resourse_available` сбрасывается в `AVAILABLE_STATE.YES`

</div>

---

### Наследование для спиральной секции ([`SpiralSectionState`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvSpiralSection/js/srvSpiralSectionStates.ts))

Для спиральных автоматов базовый класс [`BaseSectionState`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/js/srvBaseSectionState.ts#L32-L88) расширяется классом [`SpiralSectionState`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvSpiralSection/js/srvSpiralSectionStates.ts#L15-L30) в модуле [js/srvSpiralSection/js/srvSpiralSectionStates.ts](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvSpiralSection/js/srvSpiralSectionStates.ts).

```typescript
export class SpiralSectionState extends BaseSectionState<SPIRAL_CELL_STATE | CELL_STATE> {
    public Lift: LIFT_STATE;
    public DeliveryBox: DELIVERY_BOX_STATE;
    ...
}
```

#### Особенности реализации спиральной секции:
1. **Расширенные состояния ячеек:**  
   Дженерик базового класса типизируется объединением `SPIRAL_CELL_STATE | CELL_STATE`. Дополнительные состояния ячеек (`SPIRAL_CELL_STATE`), а также состояния лифта (`LIFT_STATE`) и окна выдачи (`DELIVERY_BOX_STATE`) генерируются из схемы [`spiral_section_states.schema.json`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/schema/MachineState/spiral_section_states.schema.json) в файл [`ISpiralSectionStates.ts`](file:///S:/nikita.umnov/Project-27_2025-N1-SOFT/js/srvStatesController/ts/ISpiralSectionStates.ts):
   - `SPIRAL_CELL_STATE` — статусы спиральных ячеек (`OK`, `OPENING`, `OVERLOAD_I`, `OVERLOAD_V`, `BLOCKED`, `ERROR`, `SERVICE`, `ERR_TAMPER`, `ERR_TAMPER_BAD_POS`, `ACTUATOR_SHORT_CIRCUIT`, `ACTUATOR_NO_POWER`, `ERR_MECHANICAL`, `OVERLOAD`, `TAMPER_BAD_POS_ERROR`, `NOT_CLOSED`);
   - `LIFT_STATE` — состояние лифта (`OK`, `OVERLOAD`, `BLOCKED`, `SHORT_CIRCUIT`, `NO_POWER`, `ERR_TAMPER`, `ERR_LEVEL`, `ERR_MECHANICAL`);
   - `DELIVERY_BOX_STATE` — состояние лючка выдачи (`OPENED`, `CLOSED`, `ERR_MECHANICAL`).
2. **Специфичные узлы спирального аппарата:**
   - `public Lift: LIFT_STATE` — состояние лифта перемещения товара (по умолчанию `LIFT_STATE.OK`);
   - `public DeliveryBox: DELIVERY_BOX_STATE` — состояние шторки/окна выдачи товара клиенту (по умолчанию `DELIVERY_BOX_STATE.CLOSED`).
3. **Переопределение `Reset()`:**  
   Вызывает `super.Reset()` и дополнительно сбрасывает `Lift` в `LIFT_STATE.OK`, а `DeliveryBox` в `DELIVERY_BOX_STATE.CLOSED`.

---

### Пример использования

```typescript
import { BaseSectionState } from './srvBaseSectionState';
import { SpiralSectionState } from '../../srvSpiralSection/js/srvSpiralSectionStates';
import { 
    SECTION_STATUS, 
    CELL_STATE, 
    CELL_ACTION 
} from '../ts/IBaseSectionStates';
import { 
    SPIRAL_CELL_STATE, 
    LIFT_STATE, 
    DELIVERY_BOX_STATE 
} from '../ts/ISpiralSectionStates';
import { SectionConfig, SECTION_TYPE } from '../ts/IMachineConfig';

const sectionConfig: SectionConfig = {
    Name: 'Spiral_Upper',
    ID: 'sec_1',
    Type: SECTION_TYPE.SPIRAL,
    Rows: 6,
    Cols: 10,
    PowerBus: 1,
    IOList: ['IO_Master_1'],
    Channels: {}
};

// Создание экземпляра спиральной секции, унаследованной от BaseSectionState
const spiralSection = new SpiralSectionState(sectionConfig);

// Доступ к базовым полям (реальное значение SECTION_STATUS)
spiralSection.Status = SECTION_STATUS.DISPENSE;

// Доступ к ячейкам с реальными значениями SPIRAL_CELL_STATE и CELL_ACTION
spiralSection.Cells[0] = {
    Status: SPIRAL_CELL_STATE.OVERLOAD_I,
    Action: CELL_ACTION.ACTION
};

// Доступ к компонентам спиральной секции (реальные значения LIFT_STATE и DELIVERY_BOX_STATE)
spiralSection.Lift = LIFT_STATE.OVERLOAD;
spiralSection.DeliveryBox = DELIVERY_BOX_STATE.OPENED;

// Сброс к исходному состоянию
spiralSection.Reset();
```

</div>