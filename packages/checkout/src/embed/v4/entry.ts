// The built loader's entry: it defines `<elisym-buy>` and exports nothing, so the
// IIFE leaves no global on the merchant's page (the class stays importable for tests).
import './embed';
