// The built loader's entry: it defines `<elisym-buy>` and the one global `PayCore`,
// and exports nothing, so the IIFE adds no other global to the merchant's page.
import { installPayCore } from './embed';

installPayCore();
