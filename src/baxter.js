import EventService from './services/event';
import BaxterError from './entities/error';

/**
 * @class Baxter
 * @description Main class, provides library as it self.
 */
class Baxter {
    constructor() {
        /**
         * @description Basic unique id, other uids are incremented from this
         * @type {number}
         */
        let UID = 1;

        /**
         * @name Baxter._callstack
         * @type {Map}
         */
        this._callstack = new Map();

        /**
         * @name Baxter._variables
         * @type {Map}
         */
        this._variables = new Map();

        /**
         * @name Baxter.eventStream
         * @type {EventService}
         * @description Provides events service
         */
        this.eventStream = new EventService(this);

        /**
         * @name Baxter.utils
         * @type {Object}
         */
        this.utils = {
            /**
             * @name Baxter.utils.createObjectUID
             * @param object
             * @returns {number}
             */
            createObjectUID: (object) => {
                let uid = UID++;

                Object.defineProperty(object, '__uid__', {
                    enumerable: false,
                    value: uid
                });

                return uid;
            },

            /**
             * @name Baxter.utils.getUIDByObject
             * @param object
             * @returns {*}
             */
            getUIDByObject: (object) => {
                if (!object['__uid__']) {
                    return this.utils.createObjectUID(object);
                }

                return object['__uid__']
            },

            /**
             * @name Baxter.utils.createKeyUID
             * @param owner
             * @param key
             * @returns {string}
             */
            createKeyUID: (owner, key) => {
                return this.utils.getUIDByObject(owner) + ':' + key;
            },

            /**
             * @name Baxter.utils.debounce
             * @param {Function} func
             * @param {Number} wait
             * @returns {Function} debounced function
             */
            debounce: (func, wait) => {
                var timeout;
                return () => {
                    let later = () => {
                        func();
                        timeout = null;
                    };
                    clearTimeout(timeout);
                    timeout = setTimeout(later, wait);
                };
            }
        };

        this._watchers = {

        };

        this.subscribeEvent('will-change', this.utils.debounce(() => this.postEvent('will-change-all'), 0));
    }

    /**
     * @name Baxter.subscribeEvent
     * @param {String} eventType
     * @param {Function} subscriber
     * @param {Boolean} [once]
     */
    subscribeEvent(eventType, subscriber, once = false) {
        if (typeof eventType !== 'string') {
            throw new BaxterError('subscribeEvent: eventType is not defined.');
        }

        if (typeof subscriber !== 'function') {
            throw new BaxterError('subscribeEvent: subscriber function is not defined.');
        }

        if (once) {
            this.eventStream.once(eventType, subscriber);
        } else {
            this.eventStream.on(eventType, subscriber);

            return {
                dispose: () => this.eventStream.off(eventType, subscriber)
            }
        }
    }

    /**
     * @name Baxter.postEvent
     * @param {String} eventType
     * @param {*} [data]
     */
    postEvent(eventType, data) {
        if (typeof eventType !== 'string') {
            throw new BaxterError('postEvent: eventType is not defined.');
        }

        this.eventStream.post(eventType, data);
    }

    /**
     * @name Baxter.subscribe
     * @param {Object} owner
     * @param {String} key
     * @param {Function} subscriber
     * @param {String} [eventType]
     * @param {Boolean} [once]
     * @throws {BaxterError}
     */
    subscribe(owner, key, subscriber, eventType = 'update', once = false) {
        if (!owner || !key || !subscriber) {
            throw new BaxterError('subscribe: can\'t subscribe variable without owner, key or callback function.');
        }
        let uid = this.utils.createKeyUID(owner, key);
        let availableEvents = ['will-change', 'update'];
        let eventToListen = availableEvents.indexOf(eventType) !== -1 && eventType;
        let eventHandler = (config) => {
            if (config.uid === uid) {
                subscriber(config.value, config.oldValue);
            }
        };

        if (!eventToListen) {
            throw new BaxterError('subscribe: listening ' + eventType + ' event is not accepted.');
        }

        return this.subscribeEvent(eventToListen, eventHandler, once);
    }

    /**
     * @name Baxter.resolve
     * @param {Set|Array} dependencies
     * @returns {Promise}
     */
    resolve(dependencies) {
        if (!(Symbol.iterator in dependencies)) {
            throw new BaxterError('resolve: dependencies are not iterable.');
        }

        let result = new Set();

        for (let dependency of dependencies) {
            result.add(this._callstack.get(dependency));
        }

        return Promise.all(result);
    }

    /**
     * @name Baxter.getDependencies
     * @param {Object} context
     * @param {Function} computed
     * @param {Function} callback
     * @returns {*} Result of computing
     */
    getDependencies(context, computed, callback) {
        if (!context || !computed || !callback) {
            throw new BaxterError('getDependencies: there is no context, computed function or callback.');
        }

        let listener = this.subscribeEvent('get', callback);
        let computingResult = computed.call(context);

        listener.dispose();

        return computingResult;
    }

    /**
     * @name Baxter.addToStack
     * @param {Object} owner
     * @param {String} key
     * @param {Function} callback
     */
    addToStack(owner, key, callback) {
        let uid = this.utils.createKeyUID(owner, key);

        this.postEvent('will-change', {
            uid: uid,
            owner: owner,
            key: key
        });

        this._callstack.set(uid, new Promise((resolve) => {
            this.subscribeEvent('will-change-all', () => {
                resolve(callback());
            }, true);
        })
            .then(() => {
                this._callstack.delete(uid);
                if (!this._callstack.size) {
                    this.postEvent('change-complete');
                }
            }));
    }

    /**
     * @name Baxter.variable
     * @param {Object} owner
     * @param {String} key
     * @param {*} [initialValue]
     * @returns {*} value
     */
    variable(owner, key, initialValue) {
        if (typeof owner !== 'object') {
            throw new BaxterError('variable: owner object in not defined.');
        }
        if (typeof key !== 'string') {
            throw new BaxterError('variable: key string in not defined.');
        }

        let value = initialValue;
        let uid = this.utils.createKeyUID(owner, key);

        if (this._variables.has(uid)) {
            return initialValue;
        }

        this._variables.set(uid, new Set());

        Object.defineProperty(owner, key,
            {
                configurable: true,
                set: (newValue) => {
                    if (newValue === value) {
                        return false;
                    }

                    let oldValue = value;

                    this.postEvent('will-change', {
                        uid: uid,
                        owner: owner,
                        key: key
                    });

                    value = newValue;

                    this.postEvent('update',
                        {
                            uid: uid,
                            owner: owner,
                            key: key,
                            value: value,
                            oldValue: oldValue
                        }
                    );
                },

                get: () => {
                    this.postEvent('get',
                        {
                            uid: uid,
                            owner: owner,
                            key: key,
                            value: value
                        }
                    );
                    return value;
                }
            }
        );

        return value;
    }

    /**
     * @name Baxter.computed
     * @param {Object} owner
     * @param {String} key
     * @param {Function} computedObservable
     * @param {Set|Map|Array} [userDependencies]
     * @returns {*}
     */
    computed(owner, key, computedObservable, userDependencies) {
        if (typeof owner !== 'object') {
            throw new BaxterError('computed: owner object in not defined.');
        }

        if (typeof key !== 'string') {
            throw new BaxterError('computed: key string in not defined.');
        }

        if (typeof computedObservable !== 'function') {
            throw new BaxterError('computed: computedObservable function in not defined.');
        }

        let value;
        let oldValue;
        let isComputing = false;
        let computedUID = this.utils.createKeyUID(owner, key);
        let canUpdate = false;
        let dependencies = new Set();
        let handlers = new Set();

        if (this._variables.has(computedUID)) {
            return computedObservable;
        }

        this._variables.set(computedUID, handlers);

        Object.defineProperty(owner, key, {
            configurable: true,
            get: () => {
                this.postEvent('get', {
                    uid: computedUID,
                    owner: owner,
                    key: key,
                    value: value
                });

                return value;
            },
            set: (computedValue) => {
                if (!isComputing) {
                    throw new BaxterError('you can\'t set value to computed');
                }
                isComputing = false;
                value = computedValue;

                if (value === oldValue) {
                    return false;
                }

                this.postEvent('update', {
                    uid: computedUID,
                    owner: owner,
                    key: key,
                    value: value,
                    oldValue: oldValue
                });
            }
        });

        let handleObservable = (handledValue) => {
            dependencies.add(handledValue.uid);

            let subscriber = this.subscribe(handledValue.owner, handledValue.key, () => {
                if (isComputing) {
                    return false;
                }

                isComputing = true;

                this.addToStack(owner, key, () => {
                    return this.resolve(dependencies)
                        .then(() => {
                            oldValue = value;
                            return computedObservable.call(owner);
                        })
                        .then((value) => {
                            owner[key] = value;
                        })
                        .catch(() => {
                            owner[key] = undefined;
                        });
                });
            }, 'will-change');

            handlers.add(subscriber);
        };

        if (Symbol.iterator in Object(userDependencies)) {
            for (let userDependency of userDependencies) {
                handleObservable(userDependency);
            }
        }

        let calculatedValue = this.getDependencies(owner, computedObservable, handleObservable);
        if (calculatedValue instanceof Promise) {
            calculatedValue.then((result) => {
                this.addToStack(owner, key, () => {
                    return this.resolve(dependencies)
                        .then(() => {
                            isComputing = true;
                            owner[key] = result;
                        });
                });
            });
        } else {
            isComputing = true;
            owner[key] = calculatedValue;
        }

        return value;
    }

    /**
     * @name Baxter.watch
     * @param {Object} object
     */
    watch(object) {
        if (typeof object !== 'object') {
            throw new BaxterError('watch: object is not defined.');
        }

        let computedVariables = [];

        for (let key in object) {
            if (!object.hasOwnProperty(key)) {
                continue;
            }

            let value = object[key];
            if (typeof value === 'function') {
                computedVariables.push({
                    owner: object,
                    key: key,
                    value: value
                });
            } else {
                this.variable(object, key, value);
            }
        }

        for (let index = 0; index < computedVariables.length; index++) {
            let computed = computedVariables[index];
            this.computed(computed.owner, computed.key, computed.value);
        }

        return object;
    }

    /**
     * @name Baxter.dispose
     * @param {Object} owner
     * @param {String} [key]
     */
    dispose(owner, key) {
        if (typeof owner !== 'object') {
            throw new BaxterError('Dispose: object is not defined.');
        }

        if (!key) {
            for (let field of (Object.keys(owner))) {
                let uid = this.utils.createKeyUID(owner, field);
                let handlers = this._variables.get(uid);

                if (!handlers) {
                    continue;
                }

                for (let handler of handlers) {
                    handler.dispose();
                    delete owner[field];
                }

                this._variables.delete(uid);
            }
        } else {
            let uid = this.utils.createKeyUID(owner, key);
            let handlers = this._variables.get(uid);

            if (!handlers) {
                return;
            }

            for (let handler of handlers) {
                handler.dispose();
                delete owner[key];
            }

            this._variables.delete(uid);
        }
    }
}

export default new Baxter();
