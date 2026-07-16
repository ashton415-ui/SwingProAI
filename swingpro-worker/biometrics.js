// swingpro-worker/biometrics.js

const LM = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
};

const RAD_TO_DEG = 180 / Math.PI;

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

export function calcSpineAngle(landmarks) {
  const ls = landmarks[LM.LEFT_SHOULDER];
  const rs = landmarks[LM.RIGHT_SHOULDER];
  const lh = landmarks[LM.LEFT_HIP];
  const rh = landmarks[LM.RIGHT_HIP];

  if (!ls || !rs || !lh || !rh) return null;

  const shoulder = midpoint(ls, rs);
  const hip = midpoint(lh, rh);
  const dy = hip.y - shoulder.y;
  const dx = shoulder.x - hip.x;

  if (dy <= 0) return null;
  const angle = Math.atan2(Math.abs(dx), dy) * RAD_TO_DEG;
  return Math.round(angle * 10) / 10;
}

export function calcHipRotation(landmarks) {
  const lh = landmarks[LM.LEFT_HIP];
  const rh = landmarks[LM.RIGHT_HIP];

  if (!lh || !rh) return null;
  const dz = rh.z - lh.z;
  const dx = rh.x - lh.x;
  if (Math.abs(dx) < 0.01) return null;

  const angle = Math.atan2(Math.abs(dz), Math.abs(dx)) * RAD_TO_DEG;
  return Math.round(angle * 10) / 10;
}

export function calcShoulderRotation(landmarks) {
  const ls = landmarks[LM.LEFT_SHOULDER];
  const rs = landmarks[LM.RIGHT_SHOULDER];
  if (!ls || !rs) return null;

  const dz = rs.z - ls.z;
  const dx = rs.x - ls.x;

  if (Math.abs(dx) < 0.01) return null;
  const angle = Math.atan2(Math.abs(dz), Math.abs(dx)) * (180 / Math.PI);
  return Math.round(angle * 10) / 10;
}