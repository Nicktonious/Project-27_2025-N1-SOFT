import { forwardRef, type SelectHTMLAttributes } from 'react';
import styles from './Input.module.css';

export interface SelectOption {
    value: string;
    label: string;
    disabled?: boolean;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
    label?: string;
    options: SelectOption[];
    error?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
    { label, options, error, className = '', ...rest },
    ref
) {
    const cls = [styles.input, error ? styles.inputError : '', className].filter(Boolean).join(' ');
    return (
        <label className={styles.field}>
            {label && <span className={styles.label}>{label}</span>}
            <select ref={ref} className={cls} {...rest}>
                {options.map((opt) => (
                    <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                        {opt.label}
                    </option>
                ))}
            </select>
            {error && <span className={styles.error}>{error}</span>}
        </label>
    );
});
