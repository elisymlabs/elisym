import { MemoryOrderBackend } from '../../src/buyer/order-store';
import { orderStoreContract } from './order-store.contract';

orderStoreContract(async () => new MemoryOrderBackend());
