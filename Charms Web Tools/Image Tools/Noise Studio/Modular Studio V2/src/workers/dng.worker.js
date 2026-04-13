import { createWorkerDomainHost } from './host.js';
import { dngTaskHandlers } from './tasks/dng.js';

createWorkerDomainHost('dng', dngTaskHandlers);
