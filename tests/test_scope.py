"""Wrapper regression tests; no Oracle connection required."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ScopeWrapperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        shutil.copy(ROOT / 'run_gather_dashboard.sh', self.root)
        self.capture = self.root / 'input.sql'
        fake = self.root / 'sqlplus'
        fake.write_text('''#!/bin/sh
cat > "$CAPTURE"
awk '/^@gather_dashboard.sql / { print "<script>D.meta = {\\"db\\":\\"LAB\\",\\"con\\":\\"PDB1\\"};</script>" > $5 }' "$CAPTURE"
''')
        fake.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.root) + ':' + os.environ['PATH'],
                        CAPTURE=str(self.capture), QUIET='1')
        for name in ['PDB', 'SCHEMA', 'TABLE']:
            self.env.pop(name, None)

    def run_wrapper(self, *args):
        return subprocess.run(['sh', str(self.root / 'run_gather_dashboard.sh'),
                               '/ as sysdba', *args], env=self.env,
                              text=True, capture_output=True)

    def test_combined_target_and_limits(self):
        result = self.run_wrapper('7', '--pdb', 'pdb1', '--schema', 'hr',
                                  '12', '--table', 'employees', '34')
        self.assertEqual(result.returncode, 0, result.stderr)
        sql = self.capture.read_text()
        self.assertIn('WHENEVER SQLERROR EXIT SQL.SQLCODE\nALTER SESSION SET CONTAINER = PDB1;', sql)
        self.assertRegex(sql, r'@gather_dashboard.sql 7 12 34 .* HR EMPLOYEES\n')
        self.assertIn('gather_dashboard_lab_pdb1_schema_hr_table_employees_7days_', result.stdout)
        self.assertTrue(Path(result.stdout.strip()).is_file())

    def test_environment_target(self):
        self.env.update(PDB='PDB1', SCHEMA='hr', TABLE='employees')
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(' HR EMPLOYEES\n', self.capture.read_text())
        self.assertIn('_schema_hr_table_employees_31days_', result.stdout)

    def test_default_is_unfiltered(self):
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(' - -\n', self.capture.read_text())
        self.assertNotIn('ALTER SESSION', self.capture.read_text())
        self.assertIn('gather_dashboard_lab_pdb1_31days_', result.stdout)

    def test_bad_targets_never_connect(self):
        for args in [('--table', 'T'), ('--schema', "HR';"),
                     ('--pdb', 'PDB1;'), ('--schema', 'HR%'),
                     ('--table',), ('--unknown', 'x'), ('0',), ('-1',)]:
            with self.subTest(args=args):
                result = self.run_wrapper(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.capture.exists())


if __name__ == '__main__':
    unittest.main()
