import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from '../ui/Button.tsx';
import styles from './MachineConfigLoader.module.css';

const LAST_CONFIG_STORAGE_KEY = 'vmtestrunner:lastMachineConfig';

function readCachedConfig(): Record<string, unknown> | null {
    try {
        const raw = localStorage.getItem(LAST_CONFIG_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

interface MachineConfigLoaderProps {
    onLoadConfig: (cfg: Record<string, unknown>) => void;
    isLoading?: boolean;
    error?: string | null;
}

export function MachineConfigLoader({ onLoadConfig, isLoading = false, error }: MachineConfigLoaderProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [hasCached, setHasCached] = useState<boolean>(() => readCachedConfig() !== null);

    const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text) as Record<string, unknown>;
            localStorage.setItem(LAST_CONFIG_STORAGE_KEY, JSON.stringify(parsed));
            setHasCached(true);
            onLoadConfig(parsed);
        } catch {
            // Невалидный JSON игнорируется
        } finally {
            e.target.value = '';
        }
    };

    const handleLoadLast = () => {
        const cached = readCachedConfig();
        if (cached) onLoadConfig(cached);
    };

    return (
        <div className={styles.wrapper}>
            <div className={styles.card}>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    className={styles.hiddenInput}
                    onChange={handleFileChange}
                />
                <Button
                    variant="primary"
                    className={styles.bigBtn}
                    disabled={isLoading}
                    onClick={() => fileInputRef.current?.click()}
                >
                    {isLoading ? 'Инициализация...' : 'Загрузить MachineConfig'}
                </Button>
                <Button
                    variant="secondary"
                    className={styles.bigBtn}
                    disabled={!hasCached || isLoading}
                    onClick={handleLoadLast}
                >
                    Выбрать последний
                </Button>
            </div>
            {error && <div className={styles.errorBox}>{error}</div>}
        </div>
    );
}
