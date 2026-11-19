import { useState, type ReactNode } from 'react';
import styles from './Accordion.module.css';

interface AccordionProps {
    title: string;
    defaultOpen?: boolean;
    children: ReactNode;
}

export function Accordion({ title, defaultOpen = true, children }: AccordionProps) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <section className={styles.card}>
            <button
                type="button"
                className={`${styles.header} ${open ? styles.headerOpen : ''}`}
                onClick={() => setOpen((prev) => !prev)}
            >
                <span>{title}</span>
                <span className={styles.chevron}>{open ? '▲' : '▼'}</span>
            </button>
            {open && <div className={styles.body}>{children}</div>}
        </section>
    );
}
