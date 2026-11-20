export interface ApplyIndexUseCase {
  execute(indexSql: string): Promise<void>;
}
