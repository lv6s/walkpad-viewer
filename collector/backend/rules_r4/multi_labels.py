LABELS = dict(standing='\u7ad9\u7acb', walking='\u8d70\u8def', running='\u8dd1\u6b65',
              squat='\u6df1\u8e72', stairs_up='\u4e0a\u697c\u68af', stairs_down='\u4e0b\u697c\u68af',
              unknown='\u5176\u4ed6')
MAIN_ACTIONS = frozenset(LABELS)
CANDIDATE = '\u5019\u9009'


def annotation(primary, guesses, weak):
    selected = tuple(dict.fromkeys(x for x in (primary,*guesses) if x in MAIN_ACTIONS and x != 'unknown'))
    if not selected:
        return dict(annotation=LABELS['unknown'], activity_status='other', action_candidates='')
    if len(selected)>1 or weak:
        return dict(annotation=' / '.join(LABELS[x]+CANDIDATE for x in selected),
                    activity_status='candidate', action_candidates=';'.join(selected))
    return dict(annotation=LABELS[selected[0]], activity_status='supported', action_candidates='')


def review(kind, row, inferred, squat_group, f, i):
    if kind == 'squat' and squat_group:
        return annotation(kind,(),False)
    extra = row.get('action_hypotheses', ())
    weak = (inferred and not row.get('gait_inferred')) or bool(row.get('locomotion_partial'))
    if kind == 'standing' and not row.get('gait_evidence','').startswith('cropped_ground_quiet'):
        weak |= not (f['raw_valid'][i,13] and f['raw_valid'][i,14] and f['raw_valid'][i,15] and f['raw_valid'][i,16])
    if kind == 'squat':
        weak = True
    if kind.startswith('stairs_'):
        weak |= not bool(row.get('stair_sequence_supported'))
    if row.get('ambiguous_gait'):
        weak = True
    if kind == 'unknown' and extra:
        weak = True
    return annotation(kind,extra,weak)
