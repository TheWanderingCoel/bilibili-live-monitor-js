(function() {

    'use strict';

    const colors = require('colors/safe');
    const EventEmitter = require('events').EventEmitter;

    const config = require('../global/config.js');
    const cprint = require('../util/printer.js');
    const Bilibili = require('../bilibili.js');
    const RoomidHandler = require('../handler/roomidhandler.js');
    const {
        GuardMonitor, 
        FixedGuardMonitor, 
        RaffleMonitor } = require('../danmu/bilibilisocket.js');
    const { sleep } = require('../util/utils.js');


    class AbstractController extends EventEmitter {

        constructor() {
            super();
            this.connections = new Map();
            this.roomWaitList = [];
            this.recentlyClosed = [];
            this.running = false;

            this.roomidHandler = new RoomidHandler();
            this.bind();
        }

        bind() {
            this.emit = this.emit.bind(this);
        }

        run() {
            if (this.running === false) {
                this.running = true;
                this.roomidHandler.run();
                (this.roomidHandler
                    .on('guard', (g) => this.emit('guard', g))
                    .on('gift', (g) => this.emit('gift', g))
                    .on('pk', (g) => this.emit('pk', g)));
            }
        }

        close() {
            this.connections.forEach((dmListener, key) => {
                dmListener.removeAllListeners('close');
                dmListener.close();
            });
            this.connections.clear();
        }

        updateRooms(roomList) {
            const established = Array.from(this.connections.keys());
            this.roomWaitList = Array.from(roomList).filter(room => {
                return !established.includes(room);
            });
            return this.setupMonitor();
        }

        setupMonitor() {
        }
    }

    class AbstractGuardController extends AbstractController {

        constructor() {
            super();
        }

        bind() {
            super.bind();
        }

        run() {
            super.run();
        }

        close() {
            super.close();
        }

        updateRooms(roomList) {
            const established = Array.from(this.connections.keys());
            this.roomWaitList = Array.from(roomList).filter(room => {
                return !established.includes(room);
            });
            return this.setupMonitor();
        }

        setupMonitor() {

            if (this.running === false) return Promise.resolve();

            const list = this.roomWaitList;

            const tasks = list.map((roomid, index) => {
                return (async () => {
                    await sleep(index * 50);    // 50ms 间隔
                    this.setupMonitorAtRoom(roomid);
                })();
            });

            return Promise.all(tasks).then(() => {
                if (this.recentlyClosed.length > 30) {
                    this.recentlyClosed.splice(20);
                }
            });
        }

        setupMonitorAtRoom(roomid) {
        }
    }

    class FixedController extends AbstractGuardController {

        constructor() {
            super();
        }

        setupMonitor() {
            return super.setupMonitor().then(() => {
                cprint(`[ 静态 ] Monitoring ${this.connections.size} rooms`, colors.green);
            }).catch(error => {
                cprint(`${error.message}`, colors.red);
            });
        }

        setupMonitorAtRoom(roomid) {

            if (this.recentlyClosed.includes(roomid)
                || this.connections.has(roomid)) return null;

            const dmlistener = new FixedGuardMonitor(roomid);
            this.connections.set(roomid, dmlistener);
            (dmlistener
                .on('close', () => {
                    this.connections.delete(roomid);
                    this.recentlyClosed.push(roomid);
                })
                .on('roomid', (roomid) => this.roomidHandler.enqueue(roomid))
                .on('guard', () => this.emit('add_to_db', roomid))
                .on('storm', (g) => this.emit('storm', g)));
            dmlistener.run();
        }
    }

    class DynamicController extends AbstractGuardController {

        constructor() {
            super();
        }

        updateRooms(roomList) {
            return super.updateRooms(roomList).then(() => {
                setTimeout(() => {
                    this.emit('get_new_rooms');
                }, 1000 * 60 * 2);
            });
        }

        setupMonitor() {
            return super.setupMonitor().then(() => {
                cprint(`[ 动态 ] Monitoring ${this.connections.size} rooms`, colors.green);
            }).catch(error => {
                cprint(`${error.message}`, colors.red);
            });
        }

        setupMonitorAtRoom(roomid) {

            if (this.recentlyClosed.includes(roomid)
                || this.connections.has(roomid)) return null;

            const dmlistener = new GuardMonitor(roomid);
            this.connections.set(roomid, dmlistener);
            (dmlistener
                .on('close', () => {
                    this.connections.delete(roomid);
                    this.recentlyClosed.push(roomid);

                    // 加入永久监听
                    if (dmlistener.toFixed()) {
                        this.emit('add_fixed', roomid);
                    }
                })
                .on('roomid', (roomid) => this.roomidHandler.enqueue(roomid))
                .on('storm', (g) => this.emit('storm', g)));
            dmlistener.run();
        }

    }


    class RaffleController extends AbstractController {

        constructor() {
            super();
            this.areaname = {
                '1': '娱乐', 
                '2': '网游', 
                '3': '手游', 
                '4': '绘画', 
                '5': '电台', 
                '6': '单机', 
            };
        }

        run() {
            super.run();
            this.setupMonitor();
        }

        setupMonitor() {
            const areas = [ 1, 2, 3, 4, 5, 6 ];

            // the promise returned is strictly in order.
            Bilibili.getRoomsInEachArea().forEach((promise, index) => {

                promise.then((jsonObj) => {

                    const entries = jsonObj['data']['list'];
                    const areaid = entries[0]['parent_id'] || areas[index];
                    const roomids = entries.map((entry) => {
                        return entry['roomid'];
                    });
                    this.setupMonitorInArea(areaid, roomids);

                }).catch((errorMsg) => {
                    cprint(`${Bilibili.getRoomsInEachArea.name} - ${error}`, colors.red);
                });
            });
        }

        setupMonitorInArea(areaid, rooms) {
            rooms.forEach((roomid) => {

                Bilibili.isLive(roomid).then((streaming) => {
                    if (streaming && !this.connections.has(areaid)) {

                        const dmlistener = new RaffleMonitor(roomid, areaid);
                        this.connections.set(areaid, dmlistener);

                        const msg = `Setting up monitor @room ${roomid.toString().padEnd(13)}`
                                + `in ${this.areaname[areaid]}区`;
                        cprint(msg, colors.green);
                        (dmlistener
                            .on('close', () => {
                                const reason = `@room ${roomid} in ${this.areaname[areaid]}区 is closed.`;
                                cprint(reason, colors.yellow);
                                this.connections.delete(areaid);
                                this.recoverArea(areaid);
                            })
                            .on('roomid', (roomid) => this.roomidHandler.enqueue(roomid))
                            .on('storm', g => this.emit('storm', g)));
                        dmlistener.run();
                    }
                }).catch((error) => {
                    cprint(`${Bilibili.isLive.name} - ${error}`, colors.red);
                });
            });
        }

        recoverArea(areaid) {
            Bilibili.getRoomsInArea(areaid, 10, 10).then((roomInfoList) => {

                const room_list = roomInfoList.map((roomInfo) => {
                    return roomInfo['roomid'];
                });
                this.setupMonitorInArea(areaid, room_list);

            }).catch((error) => {
                cprint(`${Bilibili.getRoomsInArea.name} - ${error}`, colors.red);
            });
        }

    }


    module.exports = {
        RaffleController,
        DynamicController,
        FixedController };
})();
