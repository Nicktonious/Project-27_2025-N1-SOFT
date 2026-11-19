import { forwardRef, type InputHTMLAttributes } from 'react';
import styles from './Input.module.css';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
    { label, error, className = '', ...rest },
    ref
) {
    const inputCls = [styles.input, error ? styles.inputError : '', className].filter(Boolean).join(' ');
    return (
        <label className={styles.field}>
            {label && <span className={styles.label}>{label}</span>}
            <input ref={ref} className={inputCls} {...rest} />
            {error && <span className={styles.error}>{error}</span>}
        </label>
    );
});
