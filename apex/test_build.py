"""Boundary checks for importing collector output into an authenticated APEX page."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from build import build, read_report


class ReportImportTests(unittest.TestCase):
    def report(self, folder, extra):
        path = Path(folder) / 'report.html'
        path.write_text('<script>var D = {};</script>\n'
                        '<script>D.meta = {"db":"TEST","generated":"2026-10-11T12:00:00Z"};</script>\n' + extra)
        return path

    def test_positional_nulls_and_trailing_commas(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.report(folder, '<script>D.ops = [\n[1,null,"x",null],\n];</script>')
            self.assertEqual(read_report(path)['ops'], [[1, None, 'x', None]])

    def test_failed_section_is_missing_and_scripts_are_not_executed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.report(folder, '<script>D.tasks = [\nORA-00942: table or view does not exist\n];</script>\n'
                               '<script>throw new Error("do not execute");</script>')
            self.assertNotIn('tasks', read_report(path))

    def test_payload_is_safe_for_html_and_never_an_application_static_file(self):
        with tempfile.TemporaryDirectory() as folder:
            payload = json.dumps([None, "</script><script>alert('x')</script>&", 'a' * 4000]).replace('</', '<\\/')
            path = self.report(folder, '<script>D.ops = [\n' + payload + ',\n];</script>')
            out = Path(folder) / 'out'
            build(SimpleNamespace(report=path, output=out, workspace='MONITORING', schema='MONITORING', app_id=101))
            snapshot = (out / 'snapshot.sql').read_text()
            application = (out / 'application.sql').read_text()
            self.assertIn('\\u003c/script\\u003e', snapshot)
            self.assertNotIn('</script>', snapshot)
            self.assertNotIn('alert', application)
            self.assertIn('NATIVE_APEX_ACCOUNTS', application)


if __name__ == '__main__':
    unittest.main()
