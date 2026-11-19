import type { ReactNode } from 'react';
import styles from './Badge.module.css';

interface BadgeProps {
    tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
    children: ReactNode;
}

export function Badge({ tone = 'neutral', children }: BadgeProps) {
    return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}
