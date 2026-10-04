import { createRouter, createWebHistory } from 'vue-router'
import { useFcConfigStore } from '../stores/fcconfig.js'
import { useConfigLeaveStore } from '../stores/config-leave.js'

const routes = [
    {
        path: '/',
        component: () => import('../components/home-workspace.vue'),
        children: [
            {
                path: '',
                name: 'Home',
                component: () => import('../components/home.vue')
            },
            {
                path: 'environment',
                name: 'Environment',
                component: () => import('../components/environment.vue')
            },
            {
                path: 'log',
                name: 'Log',
                component: () => import('../components/log.vue')
            },
            {
                path: 'firmware',
                name: 'Firmware',
                component: () => import('../components/firmware.vue')
            },
            {
                path: 'setting',
                name: 'Setting',
                component: () => import('../components/setting.vue')
            },
        ]
    },
    {
        path: '/presets',
        name: 'Presets',
        component: () => import('../components/presets.vue')
    },
    {
        path: '/power',
        name: 'Power',
        component: () => import('../components/power.vue')
    },
    {
        path: '/failsafe',
        name: 'Failsafe',
        component: () => import('../components/failsafe.vue')
    },
    {
        path: '/dashboard',
        name: 'Dashboard',
        component: () => import('../components/dashboard.vue')
    },
    {
        path: '/sensor',
        name: 'Sensor',
        component: () => import('../components/sensor.vue')
    },
    {
        path: '/port',
        name: 'Port',
        component: () => import('../components/port.vue')
    },
    {
        path: '/rc',
        name: 'Rc',
        component: () => import('../components/rc.vue')
    },
    {
        path: '/diag',
        name: 'Diag',
        component: () => import('../components/diag.vue')
    },
    {
        path: '/monitor',
        name: 'Monitor',
        component: () => import('../components/monitor.vue')
    },
    {
        path: '/preflight',
        name: 'Preflight',
        component: () => import('../components/preflight.vue')
    },
    {
        path: '/pid',
        name: 'Pid',
        component: () => import('../components/pid.vue')
    },
    {
        path: '/motor',
        name: 'Motor',
        component: () => import('../components/motor.vue')
    },
    {
        path: '/parameter',
        name: 'Parameter',
        component: () => import('../components/parameter.vue')
    },
    {
        path: '/cli',
        name: 'Cli',
        component: () => import('../components/cli.vue')
    },
    {
        path: '/ftp',
        name: 'Ftp',
        component: () => import('../components/ftp.vue')
    },
]

const router = createRouter({
    history: createWebHistory(),
    routes
})

// U0：配置事务是跨页面事实，离开编辑页时统一拦截，避免本地草稿被静默丢弃。
let leaveGuardInstalled = false
export function installUnsavedGuard() {
    if (leaveGuardInstalled) return
    const fc = useFcConfigStore()
    const leave = useConfigLeaveStore()
    router.beforeEach(async (to, from) => {
        if (to.path === from.path) return true
        // 写入中不能切页，也不能在事务尚未完成时丢弃本地文档。
        if (fc.busy) return false
        if (!fc.hasChanges) return true
        return leave.request(to.meta?.title || to.name || to.path)
    })
    leaveGuardInstalled = true
}

export default router
