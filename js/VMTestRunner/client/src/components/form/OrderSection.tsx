import { useFieldArray, useFormContext, useWatch, type FieldErrors } from 'react-hook-form';
import type { TestScenarioInput } from '@shared/scenario.schema.ts';
import { useSectionContext } from '../../hooks/useSectionContext.ts';
import { Accordion } from '../ui/Accordion.tsx';
import { Button } from '../ui/Button.tsx';
import { Input } from '../ui/Input.tsx';
import { Select } from '../ui/Select.tsx';
import styles from './FormLayout.module.css';

interface ConfigSectionItem {
    ID: string;
    Name?: string;
    Type?: string;
    Rows?: number;
    Cols?: number;
    PowerBus?: string;
}

export function OrderSection() {
    const { currentSectionMeta } = useSectionContext();
    const {
        register,
        control,
        setValue,
        formState: { errors },
    } = useFormContext<TestScenarioInput>();

    const { fields, append, remove } = useFieldArray({
        control,
        name: 'order.cells',
    });

    const command = useWatch({ control, name: 'order.command' });
    const sectionId = useWatch({ control, name: 'section.id' });
    const machineConfig = useWatch({ control, name: 'machineConfig' }) as
        | { Sections?: ConfigSectionItem[] }
        | undefined;

    const configSections = Array.isArray(machineConfig?.Sections) ? machineConfig.Sections : [];

    const handleSelectConfigSection = (id: string) => {
        const found = configSections.find((s) => String(s.ID) === id);
        if (!found) return;
        setValue('section.id', String(found.ID), { shouldDirty: true, shouldValidate: true });
        if (typeof found.Rows === 'number') setValue('section.rows', found.Rows, { shouldValidate: true });
        if (typeof found.Cols === 'number') setValue('section.cols', found.Cols, { shouldValidate: true });
        if (typeof found.PowerBus === 'string') setValue('section.powerBus', found.PowerBus, { shouldValidate: true });
    };

    const handleCommandChange = (nextCmd: string) => {
        if (nextCmd === 'GetItem' || nextCmd === 'RotateSpiral') {
            setValue(
                'order',
                { command: nextCmd, cells: [{ row: 0, column: 0, quantity: 1 }] },
                { shouldDirty: true, shouldValidate: true }
            );
        } else if (nextCmd === 'SetLiftLevel') {
            setValue('order', { command: 'SetLiftLevel', level: 0 }, { shouldDirty: true, shouldValidate: true });
        } else if (nextCmd === 'OpenDeliveryBox') {
            setValue('order', { command: 'OpenDeliveryBox' }, { shouldDirty: true, shouldValidate: true });
        }
    };

    const showCells = command === 'GetItem' || command === 'RotateSpiral';
    const cellsOrderErrors = errors.order as
        | FieldErrors<Extract<TestScenarioInput['order'], { command: 'GetItem' }>>
        | undefined;
    const liftOrderErrors = errors.order as
        | FieldErrors<Extract<TestScenarioInput['order'], { command: 'SetLiftLevel' }>>
        | undefined;

    return (
        <Accordion title="2. Секция и заказ" defaultOpen>
            {configSections.length > 0 ? (
                <Select
                    label="Целевая секция (из MachineConfig)"
                    value={sectionId ?? String(configSections[0].ID)}
                    onChange={(e) => handleSelectConfigSection(e.target.value)}
                    options={configSections.map((s) => ({
                        value: String(s.ID),
                        label: `#${s.ID} — ${s.Name ?? s.Type ?? 'Section'} (${s.Type ?? '?'}, ${s.Rows ?? '?'}x${s.Cols ?? '?'})`,
                        disabled: s.Type !== 'SPIRAL',
                    }))}
                />
            ) : (
                <span className={styles.hint}>
                    Параметры секции берутся по умолчанию (4x4, BUS-1) или из загруженного MachineConfig.
                </span>
            )}

            <div className={styles.grid2}>
                <Select
                    label="Команда (Command)"
                    value={command}
                    onChange={(e) => handleCommandChange(e.target.value)}
                    options={currentSectionMeta.commands.map((cmd) => ({ value: cmd, label: cmd }))}
                />
                {command === 'SetLiftLevel' && (
                    <Input
                        label="Целевой уровень (Level)"
                        type="number"
                        error={liftOrderErrors?.level?.message}
                        {...register('order.level', { valueAsNumber: true })}
                    />
                )}
            </div>

            {showCells && (
                <>
                    <div className={styles.itemHeader}>
                        <span className={styles.subTitle}>Ячейки заказа (order.cells)</span>
                        <Button size="sm" onClick={() => append({ row: 0, column: 0, quantity: 1 })}>
                            + Добавить ячейку
                        </Button>
                    </div>

                    {cellsOrderErrors?.cells?.message && (
                        <div className={styles.errorBox}>{cellsOrderErrors.cells.message}</div>
                    )}

                    {fields.map((field, idx) => (
                        <div key={field.id} className={styles.row}>
                            <div className={styles.grow}>
                                <Input
                                    label="Row"
                                    type="number"
                                    error={cellsOrderErrors?.cells?.[idx]?.row?.message}
                                    {...register(`order.cells.${idx}.row`, { valueAsNumber: true })}
                                />
                            </div>
                            <div className={styles.grow}>
                                <Input
                                    label="Column"
                                    type="number"
                                    error={cellsOrderErrors?.cells?.[idx]?.column?.message}
                                    {...register(`order.cells.${idx}.column`, { valueAsNumber: true })}
                                />
                            </div>
                            <div className={styles.grow}>
                                <Input
                                    label="Quantity"
                                    type="number"
                                    error={cellsOrderErrors?.cells?.[idx]?.quantity?.message}
                                    {...register(`order.cells.${idx}.quantity`, { valueAsNumber: true })}
                                />
                            </div>
                            <Button variant="danger" size="sm" onClick={() => remove(idx)}>
                                Удалить
                            </Button>
                        </div>
                    ))}
                </>
            )}
        </Accordion>
    );
}
