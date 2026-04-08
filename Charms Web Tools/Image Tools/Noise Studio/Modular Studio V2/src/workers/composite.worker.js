import { createWorkerDomainHost } from './host.js';
import { compositeTaskHandlers } from './tasks/composite.js';

createWorkerDomainHost('composite', compositeTaskHandlers);
