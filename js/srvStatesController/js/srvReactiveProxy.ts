'use strict';

import EventEmitter2 from 'eventemitter2';

/**
 * Кэш для хранения уже созданных прокси.
 * Позволяет избежать циклов и повторного проксирования одних и тех же объектов.
 */
const proxyCache = new WeakMap<object, any>();

/**
 * Создает реактивную обертку (Deep Proxy) вокруг объекта состояния.
 * 
 * @param target - Оригинальный объект, массив или экземпляр класса.
 * @param emitter - Экземпляр EventEmitter2 для генерации событий 'update'.
 * @param basePath - Текущий путь в иерархии состояния (используется для формирования топиков).
 * @returns Проксированный объект того же типа, что и target.
 */
export function createReactiveState<T extends object>(
    target: T,
    emitter: EventEmitter2,
    basePath: string[] = []
): T {
    // Если объект уже проксирован, возвращаем его из кэша
    if (proxyCache.has(target)) {
        return proxyCache.get(target);
    }

    const handler: ProxyHandler<T> = {
        get(obj: T, prop: string | symbol, receiver: any) {
            const value = Reflect.get(obj, prop, receiver);

            // 1. Пропускаем символы (например, Symbol.iterator)
            if (typeof prop === 'symbol') {
                return value;
            }

            // 2. Пропускаем внутренние свойства (начинаются с _)
            // и служебные свойства EventEmitter2 (обычно они начинаются с _ или являются методами)
            if (prop.startsWith('_')) {
                return value;
            }

            // 3. Если это метод (класса или эмиттера), привязываем контекст к оригинальному объекту
            if (typeof value === 'function') {
                return value.bind(obj);
            }

            // 4. Рекурсивно проксируем вложенные объекты и массивы
            if (value !== null && typeof value === 'object') {
                // Проверяем возможность проксирования (дескрипторы)
                const descriptor = Object.getOwnPropertyDescriptor(obj, prop);
                if (descriptor && descriptor.configurable === false && descriptor.writable === false) {
                    return value;
                }
                return createReactiveState(value, emitter, [...basePath, prop]);
            }

            return value;
        },

        set(obj: T, prop: string | symbol, newValue: any, receiver: any): boolean {
            // Не перехватываем запись в служебные поля и символы
            if (typeof prop === 'symbol' || prop.startsWith('_')) {
                return Reflect.set(obj, prop, newValue, receiver);
            }

            const oldValue = Reflect.get(obj, prop, receiver);

            // Игнорируем запись, если значение не изменилось (Deep equality не требуется по ТЗ, достаточно ===)
            /*if (oldValue === newValue) {
                return true;
            }*/

            // Применяем изменение к оригинальному объекту
            const result = Reflect.set(obj, prop, newValue, receiver);

            if (result) {
                const path = [...basePath, prop];
                // Эмитим событие обновления с требуемой структурой
                emitter.emit('update', {
                    path,
                    topic: path.join('/'),
                    state: newValue
                });
            }

            return result;
        }
    };

    const proxy = new Proxy(target, handler);
    proxyCache.set(target, proxy);
    return proxy;
}
