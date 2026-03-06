export function createStore(initialState) {
    let state = initialState;
    const listeners = new Set();

    return {
        getState() {
            return state;
        },
        setState(updater, meta = {}) {
            const nextState = typeof updater === 'function' ? updater(state) : updater;
            if (!nextState || nextState === state) return state;
            state = nextState;
            listeners.forEach((listener) => listener(state, meta));
            return state;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}
