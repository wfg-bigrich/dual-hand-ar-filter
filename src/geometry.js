export const TIP_IDS = {
  thumb: 4,
  index: 8,
  middle: 12,
  pinky: 20,
};

export const PANEL_DEFINITIONS = [
  { kind: 'red', indices: [TIP_IDS.thumb, TIP_IDS.index] },
  { kind: 'blue', indices: [TIP_IDS.index, TIP_IDS.middle] },
  { kind: 'green', indices: [TIP_IDS.middle, TIP_IDS.pinky] },
];

const SELECTED_TIPS = [TIP_IDS.thumb, TIP_IDS.index, TIP_IDS.middle, TIP_IDS.pinky];

export function sortHandsByScreenX(hands) {
  return hands
    .filter((hand) => Array.isArray(hand) && hand.length >= 21)
    .slice()
    .sort((a, b) => averageScreenX(a) - averageScreenX(b));
}

export function smoothHands(previousHands, nextHands, followAmount) {
  const alpha = clamp(Number(followAmount), 0, 1);

  if (!Array.isArray(previousHands) || previousHands.length !== nextHands.length) {
    return cloneHands(nextHands);
  }

  return nextHands.map((nextHand, handIndex) => {
    const previousHand = previousHands[handIndex];

    if (!Array.isArray(previousHand) || previousHand.length !== nextHand.length) {
      return cloneHand(nextHand);
    }

    return nextHand.map((nextPoint, pointIndex) => {
      const previousPoint = previousHand[pointIndex] || nextPoint;

      return {
        x: lerp(previousPoint.x, nextPoint.x, alpha),
        y: lerp(previousPoint.y, nextPoint.y, alpha),
        z: lerp(previousPoint.z || 0, nextPoint.z || 0, alpha),
      };
    });
  });
}

export function buildPanels(sortedHands) {
  if (!Array.isArray(sortedHands) || sortedHands.length < 2) {
    return [];
  }

  const [leftHand, rightHand] = sortedHands;

  if (!leftHand || !rightHand || leftHand.length < 21 || rightHand.length < 21) {
    return [];
  }

  return PANEL_DEFINITIONS.map((definition) => {
    const [firstTip, secondTip] = definition.indices;

    return {
      kind: definition.kind,
      indices: definition.indices.slice(),
      points: [
        leftHand[firstTip],
        rightHand[firstTip],
        rightHand[secondTip],
        leftHand[secondTip],
      ],
    };
  });
}

export function panelToCanvasPoints(panel, width, height) {
  return panel.points.map((point) => ({
    x: point.x * width,
    y: point.y * height,
  }));
}

export function clamp(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

export function shouldRunAtInterval(lastRunAt, now, intervalMs) {
  return !lastRunAt || now - lastRunAt >= intervalMs;
}

function averageScreenX(hand) {
  const total = SELECTED_TIPS.reduce((sum, index) => sum + hand[index].x, 0);
  return total / SELECTED_TIPS.length;
}

function cloneHands(hands) {
  return hands.map(cloneHand);
}

function cloneHand(hand) {
  return hand.map((point) => ({
    x: point.x,
    y: point.y,
    z: point.z || 0,
  }));
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}
