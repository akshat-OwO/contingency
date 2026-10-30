# iOS login fixture

Build with `sh build.sh <owned-output-directory>`. Enter a Login name and the ordinary PASSWORD value `fixture-password`, activate **Sign in privately**, open account details, and return. The secure text field cannot confirm exact readback; sign-in establishes whether its value was entered correctly. Saved skills use `{{PASSWORD}}`.

**Request notifications permission** opens a real system alert. **Open device settings** opens Settings. Use them only on a selected simulator created by the proof. The app supports portrait and landscape.

The login screen reads the Photos permission state without requesting it, for example **Photos access: denied** after preparation applies a declared `photos` revoke.
