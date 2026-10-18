// Skills were supplied by the team for this hackathon. Availability is only
// established when a person accepts a request; an online phone is not a person.
export const humanSkills = ['hardware', 'electronics', 'soldering', 'frontend', 'backend', 'openai'];
const team = [
  { id: 'goroman', name: 'GOROman', role: 'ハードウェア担当', skills: ['hardware'] },
  { id: 'pupu', name: 'pupu', role: 'フロントエンド担当', skills: ['frontend'] },
  { id: 'r74tech', name: 'r74tech', role: 'バックエンド担当', skills: ['backend'] },
  { id: 'limo', name: 'Limo', role: 'GPT Live・全体接続担当', skills: ['backend', 'openai'] },
];

export function findHumanExperts(requiredSkills, devices = []) {
  const wanted = new Set(requiredSkills);
  const candidates = team.map((person) => ({ ...person,
    matched_skills: person.skills.filter((skill) => wanted.has(skill)),
    availability: 'unknown', assignment_confirmed: false,
    additional_skills_to_confirm: [...wanted].filter((skill) => !person.skills.includes(skill)),
  })).filter((person) => person.matched_skills.length)
    .sort((left, right) => right.matched_skills.length - left.matched_skills.length);
  const phone = devices.find((device) => device.device_id === 'black-phone-1');
  return { candidates, source: 'team_supplied_hackathon_roles',
    dispatch: { device_id: 'black-phone-1', shared_team_desk: true,
      online: Boolean(phone?.online), simulated: phone?.simulated ?? false,
      instruction: 'Use request_human with the intended role, task and expected result. A shared phone does not guarantee that the named person accepts.' } };
}
