"""Make the golden test files for the TypeScript port: made-up input workbooks (no client data)
built with the tested Python tool. Run from the repo root:  py -3 web/test/make_fixtures.py
Writes web/test/fixtures/<name>.xlsx, <name>.txt (expected) and cases.json.
"""
import json, sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'plugins/tds-agent/skills/tds-quarter/scripts'))
import tds_cli
from openpyxl import load_workbook

OUT = Path(__file__).resolve().parent / 'fixtures'
OUT.mkdir(exist_ok=True)
RRR = '770000000000001'
DEDUCTOR = {'TAN': 'ABCD12345E', 'PAN': 'ABCFA1234Z', 'Name': 'Example Traders & Co', 'Address 1 (flat/plot)': 'Plot 1',
            'Address 2 (building)': 'Sector 24', 'Town / city': 'Faridabad', 'State code (2 digits, e.g. 12 Haryana)': '12',
            'PIN': '121005', 'Email': 'accounts@example.com', 'STD code': '129', 'Phone': '4000000',
            'Deductor type (F firm, K company, P individual ...)': 'F',
            'Responsible person - name': 'A Partner', 'Responsible person - designation': 'Partner',
            'Responsible person - PAN': 'ABCPA1234Z', 'RP address 1': 'House 9', 'RP town / city': 'Faridabad',
            'RP state code': '12', 'RP PIN': '121007', 'RP email': 'partner@example.com'}


def fill_deductor(path):
    wb = load_workbook(path); ws = wb['Deductor']
    for r in range(3, ws.max_row + 1):
        if ws.cell(r, 1).value in DEDUCTOR: ws.cell(r, 2).value = DEDUCTOR[ws.cell(r, 1).value]
    wb.save(path)


def case(name, form, quarter, challans, deductees, salary_rows=()):
    x = OUT / f'{name}.xlsx'
    tds_cli.make_template(x, form, challans, deductees, salary_rows=salary_rows)
    fill_deductor(x)
    txt = OUT / f'{name}.txt'
    rc = tds_cli.main(['build', str(x), str(txt), '--form', form, '--fy', '2026', '--quarter', str(quarter), '--rrr', RRR])
    return {'name': name, 'form': form, 'quarter': quarter, 'rrr': RRR, 'python_exit': rc}


cases = []
# Form 140: interest on challan 1, challan 2 shared with another form (tax above its rows), awkward decimals
cases.append(case('f140', '140', 2,
    [[1, '123456', '11', date(2026, 8, 17), 30000, 700, 0, 0, '200'],
     [2, '1234567', '00012', date(2026, 9, 7), 50000, 0, 0, 0, '200']],
    [[1, 'ABCPB1234Z', 'Mr. B  Kumar', '1023', date(2026, 7, 31), 400000.675, 1, 4000, None, date(2026, 7, 31), '', ''],
     [1, 'ABCFC1234Z', 'C & Sons ^ Ltd', '1027', '15/07/2026', 250000, 10, 25000, None, '15/07/2026', '', ''],
     [2, 'ABCCD1234Z', 'D Industries Pvt Ltd', '1031', date(2026, 8, 31), 2675000.675, 0.1, 2675, None, date(2026, 8, 31), '', '']]))
# Form 143: resident firm, non-resident company with PE
cases.append(case('f143', '143', 2,
    [[1, '1234567', '00013', date(2026, 8, 7), 300000, 0, 0, 0, '200']],
    [[1, 'ABCFE1234Z', 'E Scrap Traders', '1073', date(2026, 7, 31), 9000000.66, 2, 180000, None, date(2026, 7, 31), '', '', 'N', 'N', '07', ''],
     [1, 'ABCCF1234Z', 'F Global Ltd', '1073', date(2026, 7, 31), 100000, 2, 2000, None, date(2026, 7, 31), '', '', 'Y', 'N', '01', 'N']]))
# Form 138 Q2: salary rows, no rate
cases.append(case('f138q2', '138', 2,
    [[1, '1234567', '00014', date(2026, 8, 7), 25000, 0, 0, 0, '200']],
    [[1, 'ABCPG1234Z', 'G Sharma', '1002', date(2026, 7, 31), 150000, None, 25000, None, date(2026, 7, 31), '', '']]))
# Form 138 Q4: old regime (HRA, house loss, 80C/80D/80G, landlord), new regime (80CCD(2)), no PAN + previous employer
hdr = [h for h, _ in tds_cli.SALARY_COLS]
def srow(**kv):
    return [kv.get(h) for h in hdr]
sal = [
    srow(**{'PAN': 'ABCPH1234Z', 'Name': 'H Verma', 'Category (G/W/S/O)': 'G', 'Regime (Old/New)': 'Old',
            'Employed from': date(2026, 4, 1), 'Employed to': date(2027, 3, 31), 'Salary 17(1)': 1500000.5,
            'Perquisites 17(2)': 1369, 'HRA exemption 10(13A)': 120000, 'Standard deduction 16(ia)': 50000,
            'Professional tax 16(iii)': 2500, 'House property income (+) / loss (-)': -200000,
            '80C gross': 160000, '80C deductible': 150000, '80D gross': 25000, '80D deductible': 25000,
            '80G gross': 10000, '80G qualifying': 10000, '80G deductible': 5000,
            'Tax on total income': 112412.5, 'Health & education cess': 4496.5, 'TDS by this employer': 116909,
            'Rent over 1 lakh (Y/N)': 'Y', 'Landlord PANs (comma separated)': 'ABCPL1234Z',
            'Landlord names (comma separated)': 'L Owner'}),
    srow(**{'PAN': 'ABCPJ1234Z', 'Name': 'J Kaur', 'Category (G/W/S/O)': 'W', 'Regime (Old/New)': 'New',
            'Employed from': date(2026, 6, 15), 'Employed to': date(2027, 3, 31), 'Salary 17(1)': 900000,
            'Standard deduction 16(ia)': 75000, '80CCD(2) gross': 50000, '80CCD(2) deductible': 50000,
            'Tax on total income': 0, 'TDS by this employer': 0}),
    srow(**{'PAN': 'PANNOTAVBL', 'Name': 'K Singh', 'Category (G/W/S/O)': 'S', 'Regime (Old/New)': 'New',
            'Employed from': date(2026, 4, 1), 'Employed to': date(2026, 12, 31), 'Salary 17(1)': 1200000,
            'Previous employer salary': 300000, 'Standard deduction 16(ia)': 75000,
            'Tax on total income': 83200, 'Health & education cess': 3328, 'TDS by this employer': 60000,
            'TDS by previous employer': 26528, 'Higher rate for no PAN (Y/N)': 'Y'}),
]
cases.append(case('f138q4', '138', 4,
    [[1, '1234567', '00015', date(2027, 2, 7), 30000, 0, 0, 0, '200']],
    [[1, 'ABCPH1234Z', 'H Verma', '1002', date(2027, 1, 31), 125000, None, 20000, None, date(2027, 1, 31), '', ''],
     [1, 'PANNOTAVBL', 'K Singh', '1002', date(2027, 1, 31), 100000, None, 10000, None, date(2027, 1, 31), '', '']],
    salary_rows=sal))

json.dump(cases, open(OUT / 'cases.json', 'w'), indent=1)
print(json.dumps(cases))
