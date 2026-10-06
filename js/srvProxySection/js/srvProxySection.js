const { randomUUID } = require('node:crypto');
const { default: StatesController } = require('../../srvStatesController/js/srvSectionStateController');
const { GLOBAL_MACHINE_STATE, /*BUS_MEAS_STATE,*/ AVAILABLE_STATE, SECTION_STATUS } = require('../../srvStatesController/ts/IGlobalStates');

const EventEmitter = require('eventemitter2').EventEmitter2;

/*const COMMANDS = {
    GetItem: 'GetItem', //– запрос на выдачу ТМЦ из указанных ячеек;
    GetAll: 'GetAll', // – выдача ТМЦ, открытие всех ячеек (массив Cells в данном случае не учитывается);
    SetItem: 'SetItem', // – загрузка ТМЦ в указанные ячейки;
    SetAll: 'SetAll', // – загрузка ТМЦ во все ячейки по загруженной конфигурации;
    GetStatus: 'GetStatus',// – получение статуса аппарата;
    GetWeight: 'GetWeight', 
    Reboot: 'Reboot', //– перезагрузка аппарата;
    SetConfig: 'SetConfig', ///– загрузка конфигурационного файла;
    Maintenance: 'Maintenance', //– перевод аппарата в режим обслуживания
}*/
class ClassProxySection {
    /**
     * 
     * @param {object} param0 
     * @param {[import('./Messages').TypeTarget]} param0.sections 
     * @param {StatesController} param0.StateController
     */
    constructor({ sections, StateController }) {
        /** @type {EventEmitter} */
        this.Events = new EventEmitter();
        this._Sections = sections;
        this._StateController = StateController;
    }
    /**
     * @returns {Array<{ topic: string, payload: any }>}
     */
    get BaseTopics() {
        return [
            { topic: 'Machine/Sections', payload: this._Sections },
        ];
    }

    /**
     * 
     * @param {object} param0 
     * @param {import("./Messages").Transaction} param0.Transaction
     * @returns {[{ section: import('./Messages').TypeTarget, order: import('./Messages').Order }]}
     */
    ProcessTransaction({ Transaction }) {
        if (!this.GlobalStateAllowsCommand()) return;
        const { ID, Orders } = Transaction;
        
        let ordersFiltered = [];
        for (let _order of Orders) {
            if (this.IsSectionAvailable(_order.Target)) {
                ordersFiltered.push({ section: _order.Target.id, _order });
            } else {
                // this._Logger.Log({ level: 'W', msg: `Команда ${_order.Command} для секции ${_order.Target.name} не разрешена` });
                for (let Cell of _order.Cells) {
                    const response = this.CreateResponse({ Transaction, Target: _order.Target, Cell });
                    this.RouteResponse(response);
                }
            }
        }
        return ordersFiltered;
    }

    /**
     * @param {object} param0
     * @param {string} param0.section
     * @param {import("./HiLvlMessages").Response} param0.Response 
     */
    ProcessResponse({ Response }) {
        let section = this.GetSectionByTarget(Response.Target);
        if (section)
            return { topic: 'Machine/Response', payload: Response };
    }
    
    /**
     * @param {import("./Messages").TypeTarget} tag 
     * @returns {import("./Messages").TypeTarget | undefined}
     */
    GetSectionByTarget(tag) {
        return this._Sections.find(section => section.id === tag.id || section.name === tag.name);
    }

    /**
     * @method
     * @param {import("./Messages").TypeTarget} target
     * @returns {boolean} 
     */
    IsSectionAvailable(target) {
        const sectionId = target.id == process.env.SPIRAL_SECTION_ID ? 0 : 1;

        return (this.SectionStateAllowsCommand(sectionId) &&
                this.SectionPSUAllowsCommand(sectionId));
    }
    
    /**
     * @method
     * @param {import("./Messages").Order} order 
     */
    IsGetItemOrderValid(order) {
        if (order.Cells.length == 0) return false;
        const section = this._StateController.Machine.States.Sections[order.Target.name];
        if (!section) return false;
        const hasFaultCells = order.Cells.some(cell => !sectionState.isCellAvailable(cell));
        return hasFaultCells;
    }

    /**
     * 
     * @param {object} param0 
     * @returns 
     */
    ProcessHID(param0) {
        const { type, barcode, device } = param0 ?? {};
        if (!['qr', 'rfid'].includes(type.toLowerCase?.())) return;
        return { 
            topic: `Machine/${type.toUpperCase()}`,
            payload: {
                Transaction: {
                    ID: crypto.randomUUID(),					
                    Timestamp: new Date().getTime(),
                    User: {	},						
                    Source: `Lo-level - ${type.toUpperCase()}`,        
                    Target: {								
                        id: '',							 // идентификатор аппарата
                        name: 'Hi-level',				 // имя объекта назначения
                        type: 'Hi-level control',	
                        article: '12qw-5577-a7f8'			
                    },
                    Order: { barcode }	
                }
            }
        }
    }

    FilterResp(com, resp) {
        return com.ID == resp.ParentID;
    }

    RouteCommand(msg) {
        this.Events.emit('command', msg);
    }

    RouteResponse(msg) {
        this.Events.emit('response', msg);
    }

    /**
     * 
     * @param {import("./Messages").Transaction} Transaction 
     * @param {import('./Messages').TypeTarget} Target 
     * @param {import('./Messages').Cell} Cell 
     * @returns {import("./Messages").Response}
     */
    CreateResponse({Transaction, Target, Cell }) {
        const ID = randomUUID();
        const { ID: ParentID } = Transaction;
        return {
            Response: {
                ID,					 // уникальный идентификатор
                ParentID,			 // идентификатор транзакции, на которую отвечаем
                Timestamp: new Date().getTime(),  //new Date().toString().slice(0, 33)  // время выполнения транзакции
                Target: Target,
                Cell,
                Result: 'FAIL',                      
            }
        }
    }

    GlobalStateAllowsCommand() {
        const { Mode, Env } = this._StateController.Machine.States;
        return Mode == GLOBAL_MACHINE_STATE.OK;
    }

    SectionStateAllowsCommand(sectionId) {
        const sectionState = this._StateController.Machine.States.Sections[sectionId];
        if (sectionState?.Status != SECTION_STATUS.IDLE 
            ||sectionState?.IsAvailable != AVAILABLE_STATE.YES) return false;
        return true;
    }

    SectionPSUAllowsCommand(sectionId) {
        const psuId = sectionId + 2;
        let psuState = this._StateController.Machine.States.PSU?.[psuId];
        return !(psuState?.ShortCircuit == 'YES' || psuState?.Enabled == 'NO');
    }
}
module.exports = ClassProxySection;