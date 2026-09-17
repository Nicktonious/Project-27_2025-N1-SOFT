'use strict';
// srvSectionStateController.ts
import EventEmitter2 from "eventemitter2";
import BaseSectionState from "./srvBaseSectionState";
import {
    GlobalStates,
    MACHINE_STATUS,
    GLOBAL_MACHINE_STATE,
    RESOURCE_STATE,
    COMMAND_STATE,
    BUS_CURRENT_STATE,
    MEAS_STATE,
    NET_SUMMARY_STATE,
    NET_DEVICE_STATE,
    NET_LINK_STATE,
    NET_IP_STATE,
    NET_ARP_STATE,
    NET_GATEWAY_STATE,
    NET_ROUTE_STATE,
    NET_QUALITY_STATE,
    NET_POE_STATE,
    NET_CAMERA_SERVICE_STATE,
    NET_NTP_STATE,
    NET_DNS_STATE,
    NET_MQTT_STATE,
    NET_DB_SERVICE_STATE,
    NET_NODERED_STATE,
    NET_GRAYLOG_STATE,
    NET_SECURITY_STATE,
    NET_DEGRADED_STATE,
    AVAILABLE_STATE
} from "../ts/IGlobalStates";
import { GlobalMonitoring } from "../ts/IGlobalMonitoring";
import { MachineConfig, SECTION_TYPE, SectionConfig } from "../ts/IMachineConfig";
import { createReactiveState } from "./srvReactiveProxy";

export interface IPortService extends EventEmitter2 {
    Init(): Promise<void>;
    Pub(topic: string, state: string, opts?: object): void;
    Sub(topic: string): void;
    ClearRetained?(): void;
}

export interface IConstructorParams<TSection extends BaseSectionState<any> = BaseSectionState<any>> {
    sections?: TSection[];
    portServices?: IPortService[];
}

export interface IEventStateUpdate {
    path: string[];
    topic?: string;
    state: any;
    init?: boolean;
}

export interface IRootState<TSection extends BaseSectionState<any> = BaseSectionState<any>> {
    States: Omit<GlobalStates, 'Sections'> & {
        Sections: TSection[];
    };
    Monitoring: GlobalMonitoring;
    Config: MachineConfig;
}

export type IConfig = MachineConfig;

class StatesController<TSection extends BaseSectionState<any> = BaseSectionState<any>> extends EventEmitter2 {

    // Единое дерево состояния, обернутое в реактивный прокси
    public Machine: IRootState<TSection>;
    private portServices: IPortService[];
    // Флаг для предотвращения бесконечных циклов (эхо) при обновлении извне
    private _isApplyingExternal: boolean = false;
    readonly rootTopic: string = 'Machine';

    constructor(opts: IConstructorParams<TSection>, config: MachineConfig) {
        super();
        this.portServices = opts.portServices ?? [];

        for (const service of this.portServices) {
            service.Init().catch(err => console.error('[StatesController] PortService Init Error:', err));
            // Подписываемся на все вложенные топики корневого топика (MQTT wildcard '#')
            service.Sub(`${this.rootTopic}/#`);
            // Слушаем события 'message' и применяем их к нашему реактивному состоянию
            service.on('message', ({ topic, payload }) => {
                this.ApplyExternalState(topic, payload);
            });
        }

        // Формирование начального дерева состояний (States), мониторинга (Monitoring) и конфигурации (Config)
        const rawState: IRootState<TSection> = {
            States: {
                Name: config.Global?.ID || config.Global?.Model || 'Unknown',
                StartDate: config.Global?.StartDate || '',
                Command: COMMAND_STATE.IDLE,
                Status: MACHINE_STATUS.OK,
                Mode: GLOBAL_MACHINE_STATE.OK,
                Resource: RESOURCE_STATE.OK,
                Mains: {
                    Voltage: MEAS_STATE.OK
                },
                Env: {
                    Temp: MEAS_STATE.OK,
                    Hum: MEAS_STATE.OK
                },
                Bus: (config.Power?.Bus || []).map(() => ({
                    Voltage: MEAS_STATE.OK,
                    Current: BUS_CURRENT_STATE.OK
                })),
                PSU: (config.Power?.PSU || []).map(() => ({
                    VoltageIn: MEAS_STATE.OK,
                    VoltageOut: MEAS_STATE.OK,
                    CurrentOut: BUS_CURRENT_STATE.OK,
                    Temp: MEAS_STATE.OK,
                    ShortCircuit: AVAILABLE_STATE.NO,
                    Enabled: AVAILABLE_STATE.YES,
                    Resource: AVAILABLE_STATE.YES
                })),
                Net: {
                    Summary: {
                        Apparatus: NET_SUMMARY_STATE.UNKNOWN,
                        LAN: NET_SUMMARY_STATE.UNKNOWN,
                        CoreServices: NET_SUMMARY_STATE.UNKNOWN,
                        Hubs: NET_SUMMARY_STATE.UNKNOWN,
                        Cameras: NET_SUMMARY_STATE.UNKNOWN,
                        Logging: NET_SUMMARY_STATE.UNKNOWN
                    },
                    Device: {
                        Router: NET_DEVICE_STATE.UNKNOWN,
                        SW_PoE: NET_DEVICE_STATE.UNKNOWN,
                        Hub_Low: NET_DEVICE_STATE.UNKNOWN,
                        Hub_Mid: NET_DEVICE_STATE.UNKNOWN,
                        Hub_Hi: NET_DEVICE_STATE.UNKNOWN,
                        Cam1: NET_DEVICE_STATE.UNKNOWN,
                        Cam2: NET_DEVICE_STATE.UNKNOWN
                    },
                    Link: {
                        Router_Hub_Low: NET_LINK_STATE.UNKNOWN,
                        Router_Hub_Mid: NET_LINK_STATE.UNKNOWN,
                        Router_Hub_Hi: NET_LINK_STATE.UNKNOWN,
                        Router_SW_PoE: NET_LINK_STATE.UNKNOWN,
                        SW_PoE_Cam1: NET_LINK_STATE.UNKNOWN,
                        SW_PoE_Cam2: NET_LINK_STATE.UNKNOWN
                    },
                    IP: {
                        Plan: NET_IP_STATE.UNKNOWN,
                        ARP: NET_ARP_STATE.UNKNOWN,
                        Gateway: NET_GATEWAY_STATE.UNKNOWN
                    },
                    Route: {
                        Local: NET_ROUTE_STATE.UNKNOWN,
                        Internet: NET_ROUTE_STATE.UNKNOWN,
                        VPN: NET_ROUTE_STATE.UNKNOWN
                    },
                    Quality: {
                        LAN: NET_QUALITY_STATE.UNKNOWN
                    },
                    PoE: {
                        SW_PoE: NET_POE_STATE.UNKNOWN,
                        Cam1: NET_POE_STATE.UNKNOWN,
                        Cam2: NET_POE_STATE.UNKNOWN
                    },
                    Camera: {
                        Cam1_HTTP: NET_CAMERA_SERVICE_STATE.UNKNOWN,
                        Cam2_HTTP: NET_CAMERA_SERVICE_STATE.UNKNOWN,
                        Cam1_RTSP: NET_CAMERA_SERVICE_STATE.UNKNOWN,
                        Cam2_RTSP: NET_CAMERA_SERVICE_STATE.UNKNOWN
                    },
                    NTP: {
                        Server: NET_NTP_STATE.UNKNOWN,
                        Hub_Low: NET_NTP_STATE.UNKNOWN,
                        Hub_Mid: NET_NTP_STATE.UNKNOWN,
                        Hub_Hi: NET_NTP_STATE.UNKNOWN,
                        Cameras: NET_NTP_STATE.UNKNOWN
                    },
                    DNS: {
                        Server: NET_DNS_STATE.UNKNOWN,
                        LocalRecords: NET_DNS_STATE.UNKNOWN,
                        HubsResolver: NET_DNS_STATE.UNKNOWN
                    },
                    MQTT: {
                        Server: NET_MQTT_STATE.UNKNOWN,
                        Clients: NET_MQTT_STATE.UNKNOWN,
                        Retained: NET_MQTT_STATE.UNKNOWN
                    },
                    Redis: {
                        Server: NET_DB_SERVICE_STATE.UNKNOWN
                    },
                    MongoDB: {
                        Server: NET_DB_SERVICE_STATE.UNKNOWN
                    },
                    NodeRED: {
                        Hub_Low: NET_NODERED_STATE.UNKNOWN,
                        Hub_Mid: NET_NODERED_STATE.UNKNOWN,
                        Hub_Hi: NET_NODERED_STATE.UNKNOWN
                    },
                    Graylog: {
                        Server: NET_GRAYLOG_STATE.UNKNOWN,
                        Delivery_Hubs: NET_GRAYLOG_STATE.UNKNOWN,
                        Delivery_Network: NET_GRAYLOG_STATE.UNKNOWN
                    },
                    Security: {
                        UnknownDevice: NET_SECURITY_STATE.UNKNOWN,
                        OpenPorts: NET_SECURITY_STATE.UNKNOWN,
                        Firewall: NET_SECURITY_STATE.UNKNOWN,
                        Credentials: NET_SECURITY_STATE.UNKNOWN
                    },
                    Mode: {
                        Degraded: NET_DEGRADED_STATE.UNKNOWN
                    }
                },
                Sections: (opts.sections ?? []),
            },
            Monitoring: {
                Global: {
                    Uptime: 0,
                    Power: {
                        MainsVoltage: config.Power?.Mains?.Voltage ?? 230,
                        Consumption: 0
                    },
                    Energy: {
                        Day: 0,
                        Week: 0,
                        Month: 0
                    },
                    Env: {
                        Temp: -1,
                        Hum: -1
                    }
                },
                Bus: (config.Power?.Bus || []).map((b) => ({
                    Voltage: typeof b.Voltage === 'number' ? b.Voltage : parseFloat(String(b.Voltage)) || 0,
                    Current: 0
                })),
                PSU: (config.Power?.PSU || []).map((p) => ({
                    VoltageIn: p.VoltageIn ?? 230,
                    VoltageOut: p.VoltageOut ?? 0,
                    CurrentOut: 0,
                    Temp: 0,
                    Uptime: {
                        Hours: 0,
                        Nominal: 50000,
                        OVCcount: 0,
                        OVTcount: 0
                    }
                })),
                Sections: (/*opts.sections*/ config.Sections ?? []).map((sec) => ({
                    Name: sec.Name || 'Unknown',
                    Uptime: { Hours: 0, Cycles: 0, Nominal: 100000 },
                    /*Rows: Array.from({ length: sec.Rows?.length || 0 }, () => ({
                        Uptime: { Hours: 0, Cycles: 0, Nominal: 100000 }
                    })),
                    Cols: Array.from({ length: sec.Cols?.length || 0 }, () => ({
                        Uptime: { Hours: 0, Cycles: 0, Nominal: 100000 }
                    })),*/
                    Cells: Array.from({ length: sec.Rows * sec.Cols || 0 }, () => ({
                        Uptime: { Hours: 0, Cycles: 0, Nominal: 100000 }
                    })),
                    Lift: sec.Type == SECTION_TYPE.SPIRAL ? {
                        Uptime: { Hours: 0, Cycles: 0, Nominal: 100000 }
                    } : undefined,
                    DeliveryBox: sec.Type == SECTION_TYPE.SPIRAL ? {
                        Uptime: { Hours: 0, Cycles: 0, Nominal: 100000 }
                    } : undefined
                }))
            },
            Config: config
        };

        // Подписываемся на события обновления от Proxy
        this.on('update', (event: IEventStateUpdate) => {
            // Если изменение пришло извне (applyExternalState), не отправляем его обратно в брокеры
            if (this._isApplyingExternal) return;

            const topic = event.topic || event.path.join('/');
            this.onUpdate({ prop: topic, state: event.state });
        });

        // Пропускаем весь корневой объект через фабрику
        this.Machine = createReactiveState(rawState, this);

        // Рекурсивно генерируем события update с init = true
        this.emitInitialTree(rawState);
    }

    /**
     * Применяет изменения, полученные от внешних брокеров (MQTT/Redis).
     * Безопасно парсит путь и обновляет реактивное дерево.
     * 
     * @param topic - Путь в формате 'path/to/prop' (возможно с rootTopic)
     * @param payload - Новое значение
     */
    public ApplyExternalState(topic: string, payload: any) {
        // Убираем корневой префикс, чтобы получить путь внутри объекта state
        const relativePath = topic.replace(`${this.rootTopic}`, '');
        const keys = relativePath.startsWith('/') ? relativePath.slice(1).split('/') : relativePath.split('/');

        let current: any = this.Machine;

        // Итеративно спускаемся по дереву объекта
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (current[key] === undefined) {
                return;
            }
            current = current[key];
        }

        const lastKey = keys[keys.length - 1];

        let parsedValue: any = payload;
        if (!isNaN(Number(payload))) parsedValue = Number(payload);
        if (payload === 'true') parsedValue = true;
        if (payload === 'false') parsedValue = false;

        // Проверяем существование поля перед записью, чтобы избежать засорения стейта
        if (current && (current.hasOwnProperty(lastKey) || current[lastKey] !== undefined)) {
            current[lastKey] = parsedValue;
        }
    }

    /**
     * Рекурсивно обходит дерево состояния и вызывает событие 'update' 
     * с флагом init: true для всех листовых свойств.
     */
    private emitInitialTree(obj: any, basePath: string[] = []) {
        if (obj === null || typeof obj !== 'object') {
            return;
        }

        for (const key of Object.keys(obj)) {
            // Пропускаем служебные поля
            if (key.startsWith('_')) continue;

            const value = obj[key];
            // Пропускаем методы
            if (typeof value === 'function') continue;

            const currentPath = [...basePath, key];

            if (typeof value === 'object' && value !== null) {
                this.emitInitialTree(value, currentPath);
            } else {
                // Генерируем событие для скалярного значения (листа)
                this.emit('update', {
                    path: currentPath,
                    topic: currentPath.join('/'),
                    state: value,
                    init: true
                } as IEventStateUpdate);
            }
        }
    }

    private onUpdate({ prop, state }: { prop: string, state: any }) {
        const fullTopic = `${this.rootTopic}/${prop}`;
        for (const service of this.portServices) {
            service.Pub(fullTopic, String(state));
        }
    }

    Destroy() {
        this.removeAllListeners('update');
    }

    Reset() {
        for (let section of Object.values(this.Machine.States.Sections)) {
            section.Reset();
        }
        for (let port of this.portServices) {
            port.ClearRetained?.();
        }
    }
}

export default StatesController;
