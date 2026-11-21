package installation

import "strconv"

// CompareVersions сравнивает два проверенных продуктовых номера без строкового порядка.
func CompareVersions(left, right string) int {
	a, b := productVersion.FindStringSubmatch(left), productVersion.FindStringSubmatch(right)
	if a == nil || b == nil {
		return 0
	}
	for index := 1; index <= 4; index++ {
		if a[index] == b[index] {
			continue
		}
		if a[index] == "" {
			return 1
		}
		if b[index] == "" {
			return -1
		}
		digitA, _ := strconv.ParseUint(a[index], 10, 53)
		digitB, _ := strconv.ParseUint(b[index], 10, 53)
		if digitA > digitB {
			return 1
		}
		return -1
	}
	return 0
}
