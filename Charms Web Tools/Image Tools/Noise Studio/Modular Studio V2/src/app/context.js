export function createAppContext(initial = {}) {
    return {
        ...initial,
        merge(values = {}) {
            Object.assign(this, values);
            return this;
        }
    };
}
