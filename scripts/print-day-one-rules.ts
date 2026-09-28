// Prints the day-one rule set as JSON, for the reference-data migration.
import { DAY_ONE_RULES } from "../supabase/functions/_shared/rules/defaults.ts";
process.stdout.write(JSON.stringify(DAY_ONE_RULES));
