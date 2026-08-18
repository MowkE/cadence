/**
 * electron-builder afterPack hook.
 *
 * We have no Apple Developer certificate, so the mac build is ad-hoc signed
 * here. Without *any* valid signature Gatekeeper reports downloaded apps as
 * "damaged"; with an ad-hoc one it offers the normal
 * "Open Anyway" path (System Settings → Privacy & Security).
 */
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterPack(context) {
    if (context.electronPlatformName !== 'darwin') return;

    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, `${appName}.app`);

    console.log(`  • ad-hoc signing ${appPath}`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
};
