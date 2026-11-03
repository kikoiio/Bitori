import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1] / 'RSI'
sys.path.insert(0, str(ROOT))
import sandbox


class SandboxTests(unittest.TestCase):
    def test_command_collects_both_streams(self):
        result = sandbox.bounded_command([sys.executable, '-c', 'import sys; print("ok"); print("err", file=sys.stderr)'])
        self.assertEqual(result['returncode'], 0)
        self.assertEqual(result['stdout'], 'ok\n')
        self.assertEqual(result['stderr'], 'err\n')

    def test_output_is_bounded(self):
        result = sandbox.bounded_command([sys.executable, '-c', 'print("x" * 1000000)'], max_bytes=1024)
        self.assertEqual(result['reason'], 'output_limit')
        self.assertLessEqual(len(result['stdout'].encode()), 1024)

    def test_timeout_terminates_process(self):
        result = sandbox.bounded_command([sys.executable, '-c', 'import time; time.sleep(20)'], timeout=0.1)
        self.assertEqual(result['reason'], 'timeout')
        self.assertNotEqual(result['returncode'], 0)

    def test_container_has_no_network_or_privileges_and_cleans_up(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(sandbox, 'bounded_command', return_value={'returncode': 0, 'stdout': '', 'stderr': '', 'reason': None}) as execute:
                sandbox.run_container('node@sha256:test', [(Path(root), '/workspace', False)], ['node', '--version'])
            args = execute.call_args_list[0].args[0]
            self.assertIn('--cap-drop=ALL', args)
            self.assertIn('--read-only', args)
            self.assertEqual(args[args.index('--network') + 1], 'none')
            self.assertNotIn('/var/run/docker.sock', ' '.join(args))
            self.assertEqual(execute.call_args_list[-1].args[0][1:3], ['rm', '-f'])

    def test_archive_rejects_mutable_ref(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                sandbox.export_source(root, 'master', Path(root) / 'source')

    def test_digest_rejects_absolute_symlinks(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / 'link').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                sandbox.tree_digest(root)

    def test_digest_rejects_relative_symlinks_that_escape_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / 'link').symlink_to('../outside')
            with self.assertRaises(ValueError):
                sandbox.tree_digest(root)

    def test_digest_rejects_symlink_chains_that_escape_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root / 'hop').symlink_to('../outside')
            (root / 'link').symlink_to('hop')
            with self.assertRaises(ValueError):
                sandbox.tree_digest(root)

    def test_digest_rejects_dangling_symlinks(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / 'link').symlink_to('missing')
            with self.assertRaises(ValueError):
                sandbox.tree_digest(root)

    def test_digest_rejects_symlink_cycles(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root / 'first').symlink_to('second')
            (root / 'second').symlink_to('first')
            with self.assertRaises(ValueError):
                sandbox.tree_digest(root)

    def test_digest_includes_empty_directories_and_file_modes(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            target = root / 'file'
            target.write_text('content')
            initial = sandbox.tree_digest(root)
            (root / 'empty').mkdir()
            with_directory = sandbox.tree_digest(root)
            target.chmod(0o700)
            with_mode = sandbox.tree_digest(root)
        self.assertNotEqual(initial, with_directory)
        self.assertNotEqual(with_directory, with_mode)

    def test_digest_requires_an_existing_real_directory(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            with self.assertRaises(ValueError):
                sandbox.tree_digest(root / 'missing')
            (root / 'target').mkdir()
            (root / 'link').symlink_to('target', target_is_directory=True)
            with self.assertRaises(ValueError):
                sandbox.tree_digest(root / 'link')

    def test_digest_fails_when_directory_scan_fails(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(sandbox.os, 'scandir', side_effect=PermissionError('denied')):
                with self.assertRaises(PermissionError):
                    sandbox.tree_digest(root)

    def test_digest_tracks_relative_symlinks_inside_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root / '.bin').mkdir()
            (root / 'package').mkdir()
            (root / 'other').mkdir()
            (root / 'package' / 'cli.js').write_text('same content')
            (root / 'other' / 'cli.js').write_text('same content')
            link = root / '.bin' / 'tool'
            link.symlink_to('../package/cli.js')
            first = sandbox.tree_digest(root)
            link.unlink()
            link.symlink_to('../other/cli.js')
            second = sandbox.tree_digest(root)
        self.assertNotEqual(first, second)


if __name__ == '__main__':
    unittest.main()
