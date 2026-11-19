import type { ButtonHTMLAttributes } from 'react';
import styles from './Button.module.css';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'danger';
    size?: 'md' | 'sm';
}

export function Button({
    variant = 'secondary',
    size = 'md',
    className = '',
    type = 'button',
    ...rest
}: ButtonProps) {
    const cls = [styles.btn, styles[variant], size === 'sm' ? styles.sm : '', className]
        .filter(Boolean)
        .join(' ');
    return <button type={type} className={cls} {...rest} />;
}
