import { createWorkerDomainHost } from './host.js';
import { threeTaskHandlers } from './tasks/three.js';

createWorkerDomainHost('three', threeTaskHandlers);
