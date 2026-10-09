import { defineStore } from 'pinia'
import {ref, computed, reactive} from 'vue'

export const useCurrentStore = defineStore('currentState', () => {
    const attitude = reactive({
        roll: 0,
        pitch: 0,
        yaw: 0,
    })

    const cliIO = reactive({
        input: "",
        output: "",
    })

    function updateAttitude(newData) {
        Object.assign(attitude, newData)
    }

    function updateCliIO(newData) {
        Object.assign(cliIO, newData)

    }

    return { attitude, updateAttitude, cliIO, updateCliIO }
})
