--
-- 00_head.sql
-- Document head and the embedded stylesheet; opens the body and the
-- global data object D that the data sections fill in.
--
-- Each data section writes its rows in its own <script> element, so a
-- section that fails (missing grant, ORA- error spooled into the page)
-- only loses that dataset; the page reports it as not collected.
--

SELECT '<!DOCTYPE html>' || CHR(10)
    || '<html lang="en"><head><meta charset="utf-8">' || CHR(10)
    || '<meta name="viewport" content="width=device-width, initial-scale=1">' || CHR(10)
    || '<title>Statistics gathering - ' || SYS_CONTEXT('USERENV', 'DB_NAME')
    || ' / ' || SYS_CONTEXT('USERENV', 'CON_NAME') || '</title>'
FROM dual;

@@_css.sql

SELECT '</head><body><div id="app"><p class="loading">Loading...</p></div>' || CHR(10)
    || '<script>var D = {};</script>'
FROM dual;
