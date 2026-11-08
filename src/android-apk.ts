import type {FastifyInstance} from 'fastify';
import {createReadStream,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/** Built by `npm run android` (scripts/android/build-apk.ps1). */
export const androidApkPath=fileURLToPath(new URL('../dist-android/Clowder.apk',import.meta.url));

/**
 * Serves the Android app. Access comes from the listener's own gate: the owner always reaches it. The remote listener
 * admits this one GET without pairing (installRemoteAccess), since the APK holds no secrets; other /app/ paths need a paired device.
 */
export function registerAndroidApk(app:FastifyInstance,file:string=androidApkPath){
  app.get('/app/clowder.apk',async(_req,reply)=>{
    if(!existsSync(file))return reply.code(404).send({error:'The Android app has not been built. Run npm run android.'});
    reply.header('Content-Type','application/vnd.android.package-archive');
    reply.header('Content-Disposition','attachment; filename="Clowder.apk"');
    return reply.send(createReadStream(file));
  });
}
