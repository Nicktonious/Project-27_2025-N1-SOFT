const dotenv = require('dotenv');
const mqtt = require('mqtt');
const { exec } = require('child_process');
const EventEmitter = require('events');
const BuzzerCtrl = require('./BuzzerRPi');
const sleep = require('timers/promises').setTimeout;

const POWEROFF_INTERNAL_CMD = 'echo "Powering OFF mid/hi hubs..."';
const POWERON_INTERNAL_CMD = 'echo "Powering ON mid/hi hubs..."';
const LOCAL_POWEROFF_CMD = 'sudo systemctl poweroff';   //`echo "systemctl poweroff"`
const LOCAL_REBOOT_CMD =  'sudo systemctl reboot'; //`echo "systemctl reboot"`

dotenv.config();

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Executes a shell command and returns execution success status and outputs.
 * @param {string} cmd 
 * @returns {Promise<{success: boolean, stdout?: string, error?: Error, stderr?: string}>}
 */
function runCommand(cmd) {
    return new Promise((resolve) => {
        console.log(`[EXEC] Running command: ${cmd}`);
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`[EXEC ERROR] Command failed: ${cmd}`, error);
                resolve({ success: false, error, stderr });
            } else {
                console.log(`[EXEC SUCCESS] Output: ${stdout.trim()}`);
                resolve({ success: true, stdout });
            }
        });
    });
}

/**
 * Builds the SSH command for remote command execution.
 * @param {string} sshUser
 * @param {string} sshKeyPath
 * @param {string} ip 
 * @param {string} remoteCommand 
 * @returns {string}
 */
function getSshCommand(sshUser, sshKeyPath, ip, remoteCommand) {
    return `ssh -o StrictHostKeyChecking=accept-new -i ${sshKeyPath} ${sshUser}@${ip} '${remoteCommand}'`;
}

// ==========================================
// DECOUPLED MQTT CONTROLLER
// ==========================================

class MqttController extends EventEmitter {
    constructor(options = {}) {
        super();
        this.brokerUrl = options.brokerUrl;
        this.username = options.username;
        this.password = options.password;
        this.listenTopic = options.listenTopic;
        this.client = null;
    }

    /**
     * Establishes connection to the MQTT broker and subscribes to the main command topic.
     */
    connect() {
        const connectOptions = {};
        if (this.username) connectOptions.username = this.username;
        if (this.password) connectOptions.password = this.password;

        console.log(`[MQTT] Connecting to broker at ${this.brokerUrl}...`);
        this.client = mqtt.connect(this.brokerUrl, connectOptions);

        this.client.on('connect', () => {
            console.log('[MQTT] Connected to broker successfully.');
            if (this.listenTopic) {
                this.client.subscribe(this.listenTopic, (err) => {
                    if (err) {
                        console.error(`[MQTT] Subscription error on topic ${this.listenTopic}:`, err);
                    } else {
                        console.log(`[MQTT] Subscribed to topic: ${this.listenTopic}`);
                    }
                });
            }
        });

        this.client.on('message', (topic, message) => {
            const payload = message.toString().trim();
            if (topic === this.listenTopic) {
                console.log(`[MQTT] Received message on ${topic}: "${payload}"`);
                if (payload === 'reboot' || payload === 'stop') {
                    // Hide command reception behind an event
                    this.emit('command', payload);
                } else {
                    console.warn(`[MQTT] Ignored unknown payload: "${payload}"`);
                }
            }
        });

        this.client.on('error', (err) => {
            console.error('[MQTT] Connection error:', err);
        });

        this.client.on('close', () => {
            console.log('[MQTT] Connection closed.');
        });
    }

    /**
     * Publishes a command to the specified topic.
     * @param {string} topic 
     * @param {string} command 
     */
    publishCommand(topic, command) {
        if (this.client && this.client.connected) {
            console.log(`[MQTT] Publishing "${command}" to topic: ${topic}`);
            this.client.publish(topic, command, { qos: 1, retain: true }, (err) => {
                if (err) {
                    console.error(`[MQTT] Publish error on ${topic}:`, err);
                }
            });
        } else {
            console.error(`[MQTT] Cannot publish command "${command}" to ${topic}: client not connected.`);
        }
    }
}

// ==========================================
// SHUTDOWN MANAGER (Hub-Low Execution)
// ==========================================

class ShutdownManager extends EventEmitter {
    constructor({ config, buzzer, onPreShutdown }) {
        super();
        this.config = config ?? {};
        this.isShutdownInProgress = false;
        this.onPreShutdown = onPreShutdown;
        /** @type {BuzzerCtrl} */
        this.buzzer = buzzer; 
    }

    /**
     * Orchestrates the shutdown or reboot sequence.
     * @param {'reboot'|'stop'} command 
     */
    async handleMachineCommand(command) {
        if (this.isShutdownInProgress) {
            console.log(`[ShutdownManager] Sequence already in progress. Ignoring duplicate command: "${command}"`);
            return;
        }

        // 1. Проверка возможности выполнения команды
        const canProceed = await this.canExecuteCommand(command);
        if (!canProceed) {
            console.log(`[ShutdownManager] Command execution is not allowed at this moment.`);
            return;
        }
        if (this.buzzer)
            this.buzzer.IndicateShutdownStart();

        this.isShutdownInProgress = true;
        console.log(`[ShutdownManager] Executing command: "${command}"`);

        try {
            // 2. Дублирует полученную команду в топики Mid и Hi
            console.log('[ShutdownManager] Duplicating commands to Mid and Hi hubs...');
            this.emit('internal-command', this.config.topicMid, command);
            this.emit('internal-command', this.config.topicHi, command);

            // 3. Ожидает заданный таймаут "мягкий останов"
            console.log(`[ShutdownManager] Waiting for soft stop timeout (${this.config.softStopTimeoutMs}ms)...`);
            await sleep(this.config.softStopTimeoutMs);

            // 4. Отправляет Linux-команду poweroff через SSH на верхний и средний уровень
            console.log('[ShutdownManager] Instructing Mid and Hi hubs to power off via SSH...');
            const midSshCmd = getSshCommand(this.config.sshUser, this.config.sshKeyPath, this.config.hubMidIp, 'sudo systemctl poweroff');
            const hiSshCmd = getSshCommand(this.config.sshUser, this.config.sshKeyPath, this.config.hubHiIp, 'sudo systemctl poweroff');

            // await runCommand(midSshCmd);

            // 5. Ожидает таймаут "жёсткий останов"
            console.log(`[ShutdownManager] Waiting for hard stop timeout (${this.config.hardStopTimeoutMs}ms)...`);
            await sleep(this.config.hardStopTimeoutMs);

            // 6. Снимает питание с hub-mid и hub-low (power relays)
            // console.log('[ShutdownManager] De-energizing hub-mid and hub-hi hardware relays...');
            
            // await runCommand(POWEROFF_INTERNAL_CMD);

            // Execute pre-shutdown hook (e.g. closing MQTT connection) before local system reboot/halt
            if (typeof this.onPreShutdown === 'function') {
                console.log('[ShutdownManager] Triggering pre-shutdown hook...');
                await this.onPreShutdown();
            }
            if (command === 'reboot') {
                // В случае reboot выдерживается короткая пауза, и питание подаётся повторно
                console.log(`[ShutdownManager] Reboot mode active. Waiting pause (${this.config.rebootPauseMs}ms) before restoring power...`);
                await sleep(this.config.rebootPauseMs);

                // console.log('[ShutdownManager] Energizing hub-mid and hub-hi hardware relays...');
                
                // await runCommand(POWERON_INTERNAL_CMD);
                
                // 7. hub-low перезагружается
                if (this.buzzer)
                    await this.buzzer.IndicateShutdownFinal();
                console.log('[ShutdownManager] Initiating local reboot (hub-low)...');
                await runCommand(LOCAL_REBOOT_CMD);
            } else {
                await runCommand(hiSshCmd);
                await sleep(3000); 
                // 7. hub-low выключается командой poweroff
                console.log('[ShutdownManager] Initiating local shutdown (hub-low)...');
                if (this.buzzer)
                    await this.buzzer.IndicateShutdownFinal();
                await runCommand(LOCAL_POWEROFF_CMD);
            }

        } catch (error) {
            console.error('[ShutdownManager] Exception occurred during shutdown sequence:', error);
            this.isShutdownInProgress = false;
        }
    }

    /**
     * Checks if it is safe to perform the shutdown/reboot command.
     * @param {string} command 
     * @returns {Promise<boolean>}
     */
    async canExecuteCommand(command) {
        // Can be extended to verify lock states, dispense statuses, or database locks.
        return true;
    }
}

// ==========================================
// SHUTDOWN MANAGER FACADE
// ==========================================

class ShutdownManagerFacade {
    /**
     * @param {object} config Configuration parameters to customize topics, IPs, timeouts, and hardware command strings
     */
    constructor({config = {}, buzzer}) {
        // Build settings, prioritizing user-provided options, then environment variables, then sensible defaults
        this.config = {
            mqttBrokerUrl: config.mqttBrokerUrl ?? `mqtt://'127.0.0.1':1883`,
            mqttUsername: config.mqttUsername ?? '',
            mqttPassword: config.mqttPassword ?? '',
            
            topicMachine: config.topicMachine || 'Machine/Control/State/Machine',
            topicMid: config.topicMid || 'Machine/Control/State/Mid',
            topicHi: config.topicHi || 'Machine/Control/State/Hi',
            
            hubMidIp: config.hubMidIp || '10.130.1.22',
            hubHiIp: config.hubHiIp || '10.130.1.23',
            
            sshUser: config.sshUser || 'system',
            sshKeyPath: config.sshKeyPath || '~/.ssh/hub_rsa_system',
            
            softStopTimeoutMs: config.softStopTimeoutMs ?? 15000,
            hardStopTimeoutMs: config.hardStopTimeoutMs ?? 10000,
            rebootPauseMs: config.rebootPauseMs ?? 2000,
        };

        // Initialize underlying modules
        this.mqttController = new MqttController({
            brokerUrl: this.config.mqttBrokerUrl,
            username: this.config.mqttUsername,
            password: this.config.mqttPassword,
            listenTopic: this.config.topicMachine
        });

        this.shutdownManager = new ShutdownManager({
            config: this.config,
            buzzer,
            onPreShutdown: async () => {
                await this.Destroy();
            }
        });

        // Glue MQTT Controller and Shutdown Manager events together (Decoupling)
        this.mqttController.on('command', (cmd) => {
            this.shutdownManager.handleMachineCommand(cmd);
        });

        this.shutdownManager.on('internal-command', (topic, cmd) => {
            this.mqttController.publishCommand(topic, cmd);
        });
    }

    /**
     * Connects to the MQTT broker and starts listening for commands.
     */
    Start() {
        this.mqttController.connect();
        console.log('[ShutdownManagerFacade] Shutdown Manager Service started on Hub-Low.');
    }

    PowerOff() {
        console.log('[ShutdownManagerFacade] Initiating local power off sequence...');
        this.shutdownManager.handleMachineCommand('stop');
    }

    Reboot() {
        console.log('[ShutdownManagerFacade] Initiating local reboot sequence...');
        this.shutdownManager.handleMachineCommand('reboot');
    }

    /**
     * Gracefully disconnects the MQTT client.
     * @returns {Promise<void>}
     */
    Destroy() {
        return new Promise((resolve) => {
            if (this.mqttController && this.mqttController.client) {
                console.log('[ShutdownManagerFacade] Gracefully ending MQTT connection...');
                this.mqttController.client.end(false, {}, () => {
                    console.log('[ShutdownManagerFacade] MQTT connection terminated.');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

// ==========================================
// EXPORTS & SERVICE ENTRY
// ==========================================

module.exports = {
    ClassShutdownManager: ShutdownManagerFacade,
    MqttController,
    ShutdownManager
};

// // Start the service automatically if executed directly
// if (require.main === module) {
//     const facade = new ShutdownManagerFacade();
//     facade.Start();
// }
