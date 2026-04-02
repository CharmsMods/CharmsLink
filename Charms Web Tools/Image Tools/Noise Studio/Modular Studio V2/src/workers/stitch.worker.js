import { createWorkerDomainHost } from './host.js';
import { stitchTaskHandlers } from './tasks/stitch.js';

createWorkerDomainHost('stitch', stitchTaskHandlers);
